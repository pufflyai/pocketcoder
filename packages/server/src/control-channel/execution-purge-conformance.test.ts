import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { buildServer } from "../app";
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
      expect(await f.store.inputs.getManifest(a.acceptance.execution.requestId)).toBeNull();
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
      expect((await f.store.inputs.getManifest(a.acceptance.execution.requestId))?.finalizedAt).toBeNull();
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
      expect((await f.store.inputs.getManifest(a.acceptance.execution.requestId))?.finalizedAt).toBeNull();
      await f.store.close();
      if (!f.directory) throw new Error("Disk fixture missing");
      reopened = await PGliteStore.create(f.directory);
      const restarted = buildServer({ ...f.serverOptions, store: reopened });
      await restarted.persistence.retryPurges();
      expect((await reopened.getOperation(operation.id))?.state).toBe("succeeded");
      expect(await reopened.inputs.getManifest(a.acceptance.execution.requestId)).toBeNull();
      await restarted.persistence.retryPurges();
    } finally {
      await reopened?.close();
      await f.dispose();
    }
  },
  30_000,
);
