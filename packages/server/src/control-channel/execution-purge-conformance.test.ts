import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { eq } from "drizzle-orm";
import { buildServer } from "../app";
import { createCoordinatorTick } from "../lifecycle/coordinator-tick";
import { Readiness } from "../observability/health";
import { authed } from "../testing/test-server.test";
import { dockerExecutionFixture, executionDockerImage } from "./execution-docker-fixture.test";

const available =
  Bun.spawnSync(["docker", "image", "inspect", executionDockerImage], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

test.skipIf(!available).each(["canceled-empty", "canceled-input", "terminal", "lost"])(
  "verified workspace purge releases %s execution inputs without manual finalization",
  async (state) => {
    const f = await dockerExecutionFixture();
    try {
      const a = await f.prepare(state !== "canceled-empty");
      await f.store.executions.accept(a.acceptance, new Date());
      if (state.startsWith("canceled")) {
        await f.store.executions.cancel(
          { execution: a.acceptance.execution, cancelId: randomUUID(), scope: "operation" },
          new Date(),
        );
      } else if (state === "terminal") {
        await f.executionDispatcher.tick();
        await f.waitFor(async () => (await f.store.executions.get(a.acceptance.execution))?.phase === "terminal");
      } else {
        await f.store.executions.claim(a.acceptance.execution, new Date());
        await f.driver.remove(a.ref);
        await f.store.endWorkspaceRuntime(a.workspace.id, a.acceptance.execution.incarnationId, new Date());
      }
      const response = await f.app.request(
        `/v1/workspaces/${a.workspace.id}/purge`,
        authed(a.token, {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: "{}",
        }),
      );
      expect(response.status).toBe(202);
      const operation = (await response.json()) as { id: string };
      await f.persistence.drain();
      await f.persistence.retryPurges();
      expect((await f.store.getOperation(operation.id))?.state).toBe("succeeded");
      expect(await f.store.inputs.getManifest(executionInputManifestId(a.acceptance))).toBeNull();
      expect(await f.store.executions.get(a.acceptance.execution)).toBeNull();
    } finally {
      await f.dispose();
    }
  },
  30_000,
);

test.skipIf(!available)(
  "a failed provider stop keeps pins until purge can prove termination",
  async () => {
    const f = await dockerExecutionFixture();
    const stop = f.driver.stop.bind(f.driver);
    try {
      const a = await f.prepare(true);
      await f.store.executions.accept(a.acceptance, new Date());
      await f.store.executions.claim(a.acceptance.execution, new Date());
      f.driver.stop = async () => {
        throw new Error("cut before provider stop");
      };
      const response = await f.app.request(
        `/v1/workspaces/${a.workspace.id}/purge`,
        authed(a.token, {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: "{}",
        }),
      );
      const operation = (await response.json()) as { id: string };
      await f.persistence.drain();
      expect((await f.store.getOperation(operation.id))?.state).toBe("pending");
      expect((await f.store.inputs.getManifest(executionInputManifestId(a.acceptance)))?.finalizedAt).toBeNull();
      expect((await f.driver.inspect(a.ref)).running).toBe(true);
      f.driver.stop = stop;
      await f.persistence.retryPurges();
      expect((await f.store.getOperation(operation.id))?.state).toBe("succeeded");
    } finally {
      f.driver.stop = stop;
      await f.dispose();
    }
  },
  30_000,
);

test.skipIf(!available)(
  "purge recovers after a controller restart between provider stop and pin release",
  async () => {
    const f = await dockerExecutionFixture();
    let reopened: PGliteStore | undefined;
    try {
      const a = await f.prepare(true);
      await f.store.executions.accept(a.acceptance, new Date());
      await f.store.executions.claim(a.acceptance.execution, new Date());
      f.store.inputs.finalizeForPurge = async () => {
        throw new Error("cut after provider stop");
      };
      const response = await f.app.request(
        `/v1/workspaces/${a.workspace.id}/purge`,
        authed(a.token, {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: "{}",
        }),
      );
      const operation = (await response.json()) as { id: string };
      await f.persistence.drain();
      expect((await f.store.getOperation(operation.id))?.state).toBe("pending");
      expect((await f.driver.inspect(a.ref)).exists).toBe(false);
      expect((await f.store.inputs.getManifest(executionInputManifestId(a.acceptance)))?.finalizedAt).toBeNull();
      await f.store.close();
      if (!f.directory) throw new Error("Disk fixture missing");
      reopened = await PGliteStore.create(f.directory);
      const restarted = buildServer({ ...f.serverOptions, store: reopened });
      await restarted.persistence.retryPurges();
      expect((await reopened.getOperation(operation.id))?.state).toBe("succeeded");
      expect(await reopened.inputs.getManifest(executionInputManifestId(a.acceptance))).toBeNull();
      await restarted.persistence.retryPurges();
    } finally {
      await reopened?.close();
      await f.dispose();
    }
  },
  30_000,
);

test.skipIf(!available)(
  "purge drains input publication and keeps another execution with the same request ID",
  async () => {
    const f = await dockerExecutionFixture();
    const publish = f.driver.publishInputs.bind(f.driver);
    const purge = f.driver.purgeInput.bind(f.driver);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishing = false,
      published = false,
      purged = false;
    try {
      const requestId = randomUUID();
      const a = await f.prepare(true, requestId),
        b = await f.prepare(true, requestId);
      f.driver.publishInputs = async (ref, input) => {
        if (ref.id === a.ref.id) {
          publishing = true;
          await gate;
          const result = await publish(ref, input);
          published = true;
          return result;
        }
        return publish(ref, input);
      };
      f.driver.purgeInput = async (id) => {
        if (id === a.workspace.id) {
          expect(published).toBe(true);
          purged = true;
        }
        await purge(id);
      };
      for (const item of [a, b]) await f.store.executions.accept(item.acceptance, new Date());
      await f.executionDispatcher.tick();
      await f.waitFor(
        async () => publishing && (await f.store.executions.get(b.acceptance.execution))?.phase === "terminal",
      );
      const response = await f.app.request(
        `/v1/workspaces/${a.workspace.id}/purge`,
        authed(a.token, {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: "{}",
        }),
      );
      expect(response.status).toBe(202);
      const operation = (await response.json()) as { id: string };
      await Bun.sleep(40);
      expect(purged).toBe(false);
      release();
      await f.persistence.drain();
      expect((await f.store.getOperation(operation.id))?.state).toBe("succeeded");
      expect(purged).toBe(true);
      expect(await f.store.inputs.getManifest(executionInputManifestId(a.acceptance))).toBeNull();
      expect((await f.store.inputs.getManifest(executionInputManifestId(b.acceptance)))?.finalizedAt).toBeNull();
      expect((await f.driver.inspect(b.ref)).running).toBe(true);
      await f.store.executions.finalize(b.acceptance.execution, new Date());
      expect((await f.store.inputs.getManifest(executionInputManifestId(b.acceptance)))?.finalizedAt).toBeInstanceOf(
        Date,
      );
    } finally {
      release();
      await f.executionDispatcher.drain();
      await f.persistence.drain();
      f.driver.publishInputs = publish;
      f.driver.purgeInput = purge;
      await f.dispose();
    }
  },
  30000,
);

test.skipIf(!available)(
  "coordinator keeps sweeping deadlines while purge drains a held input publication",
  async () => {
    const f = await dockerExecutionFixture();
    const publish = f.driver.publishInputs.bind(f.driver);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let publishing = false;
    let tick: Promise<void> | undefined;
    try {
      const a = await f.prepare(true);
      f.driver.publishInputs = async (ref, input) => {
        publishing = true;
        await gate;
        return publish(ref, input);
      };
      await f.store.executions.accept(a.acceptance, new Date());
      await f.executionDispatcher.tick();
      await f.waitFor(async () => publishing);
      await f.app.request(
        `/v1/workspaces/${a.workspace.id}/purge`,
        authed(a.token, {
          method: "POST",
          headers: { "Idempotency-Key": randomUUID() },
          body: "{}",
        }),
      );
      const readiness = new Readiness();
      const coordinator = createCoordinatorTick({ ...f, readiness });
      const startedAt = performance.now();
      tick = coordinator();
      const completed = await Promise.race([tick.then(() => true), Bun.sleep(1000).then(() => false)]);
      expect(completed).toBe(true);
      console.log(
        JSON.stringify({
          gate: "PC-129-coordinator",
          heldPublication: true,
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      );
      expect(readiness.snapshot().checks.cleanup).toBe("pending");
      const b = await f.prepare(false);
      await f.context.db
        .update(f.context.tables.workspaces)
        .set({ deadlineAt: new Date(Date.now() - 1) })
        .where(eq(f.context.tables.workspaces.id, b.workspace.id));
      await coordinator();
      await f.scheduler.drain();
      expect((await f.store.getWorkspace(b.workspace.id))?.state).toBe("expired");
      expect((await f.store.getWorkspace(a.workspace.id))?.purgeRequestedAt).toBeInstanceOf(Date);
    } finally {
      release();
      await tick;
      await f.executionDispatcher.drain();
      await f.persistence.drain();
      f.driver.publishInputs = publish;
      await f.dispose();
    }
  },
  30000,
);
