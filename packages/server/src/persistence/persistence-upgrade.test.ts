import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { preservedSource, registerVersion, resume, server, waitFor } from "./persistence-support.test";

const createStore = createTestStoreFactory();
type TestServer = Awaited<ReturnType<typeof server>>;

const UPGRADED_IMAGE = `example.test/fixture-persistent@sha256:${"b".repeat(64)}`;

async function restoredFile(testServer: TestServer, workspaceId: string) {
  const storage = await testServer.store.getWorkspaceStorage(workspaceId);
  return readFile(join(String(storage?.providerRef.root), "worktree", "state.txt"), "utf8");
}

async function workspacesNamed(testServer: TestServer, externalId: string) {
  return testServer.store.listWorkspaces(testServer.principal.id, { externalId, limit: 10 });
}

describe("resume onto a newer template version", () => {
  test("runs the requested version with the saved state, while ordinary resume keeps the checkpoint version", async () => {
    const testServer = await server(await createStore());
    const { sourceId, checkpointId } = await preservedSource(testServer);
    const upgraded = await registerVersion(testServer, "1.1.0", (spec) => {
      spec.image = UPGRADED_IMAGE;
      spec.resources = { ...spec.resources, memory: "1Gi" };
      for (const mount of spec.persistence.mounts) mount.maxBytes *= 2;
    });

    const response = await resume(testServer, sourceId, "upgrade-1", {
      external_id: "upgraded",
      template_version: "1.1.0",
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { workspace: { id: string }; operation: { id: string } };
    expect(body).toMatchObject({
      workspace: {
        template: { name: "fixture-persistent", version: "1.1.0", digest: upgraded.digest },
        restored_from_checkpoint_id: checkpointId,
      },
      resume: { status: "supported", checkpoint_id: checkpointId },
    });
    await testServer.scheduler.tick();
    await waitFor(async () => (await testServer.store.getOperation(body.operation.id))?.state === "succeeded");
    const launch = testServer.driver.created.find((entry) => entry.workspace.id === body.workspace.id);
    expect(launch?.workspace.templateSnapshot.spec.image).toBe(UPGRADED_IMAGE);
    expect(launch?.workspace.templateSnapshot.spec.resources.memory).toBe("1Gi");
    expect(testServer.driver.inputFor(body.workspace.id)?.template_digest).toBe(upgraded.digest);
    expect(await restoredFile(testServer, body.workspace.id)).toBe("saved on A\n");

    const ordinary = await resume(testServer, sourceId, "ordinary-1", { external_id: "ordinary" });
    expect(ordinary.status).toBe(202);
    expect(await ordinary.json()).toMatchObject({
      workspace: { template: { version: "1.0.0", digest: testServer.parsed.digest } },
    });
  });

  test("rejects incompatible and unauthorized targets without replacing the source", async () => {
    const testServer = await server(await createStore());
    const { sourceId, checkpointId } = await preservedSource(testServer);
    await registerVersion(testServer, "2.0.0-moved", (spec) => {
      for (const mount of spec.persistence.mounts) mount.target = "/moved";
    });
    await registerVersion(testServer, "2.0.0-smaller", (spec) => {
      for (const mount of spec.persistence.mounts) mount.maxFiles = 1;
    });
    await registerVersion(testServer, "2.0.0-session", (spec) => {
      spec.persistence.sessionCompatibility = "fixture/v2";
    });

    const rejected = async (key: string, version: string) => {
      const response = await resume(testServer, sourceId, key, { external_id: key, template_version: version });
      return { status: response.status, body: await response.json() };
    };
    expect(await rejected("moved", "2.0.0-moved")).toMatchObject({
      status: 409,
      body: { error: { code: "restore.incompatible", details: { reason: "persistence_mounts" } } },
    });
    expect(await rejected("smaller", "2.0.0-smaller")).toMatchObject({
      status: 409,
      body: { error: { code: "restore.incompatible", details: { reason: "persistence_mounts" } } },
    });
    expect(await rejected("session", "2.0.0-session")).toMatchObject({
      status: 409,
      body: { error: { code: "restore.incompatible", details: { reason: "session_format" } } },
    });
    expect(await rejected("missing", "9.9.9")).toMatchObject({
      status: 404,
      body: { error: { code: "template.version_not_found" } },
    });
    // A rejection records nothing, so a retry with the same key checks again and fails the same way.
    expect(await rejected("moved", "2.0.0-moved")).toMatchObject({ status: 409 });

    await testServer.store.updatePrincipal(testServer.principal.id, testServer.principal.scopes, []);
    expect(await rejected("unauthorized", "1.0.0")).toMatchObject({
      status: 403,
      body: { error: { code: "restore.template_not_authorized" } },
    });
    await testServer.store.updatePrincipal(testServer.principal.id, testServer.principal.scopes, [
      "fixture-persistent",
    ]);

    for (const externalId of ["moved", "smaller", "session", "missing", "unauthorized"]) {
      expect(await workspacesNamed(testServer, externalId)).toHaveLength(0);
    }
    expect((await testServer.store.getWorkspace(sourceId))?.state).toBe("preserved");
    expect((await testServer.store.getCheckpoint(checkpointId))?.state).toBe("ready");
    const recovered = await resume(testServer, sourceId, "after-rejections", { external_id: "after-rejections" });
    expect(recovered.status).toBe(202);
  });

  test("converges retried and concurrent upgrade requests on one replacement", async () => {
    const testServer = await server(await createStore());
    const { sourceId } = await preservedSource(testServer);
    await registerVersion(testServer, "1.1.0", (spec) => {
      spec.image = UPGRADED_IMAGE;
    });
    const body = { external_id: "converged", template_version: "1.1.0" };

    const concurrent = await Promise.all([1, 2, 3].map(() => resume(testServer, sourceId, "converge", body)));
    const retried = await resume(testServer, sourceId, "converge", body);
    const ids = await Promise.all(
      [...concurrent, retried].map(async (response) => {
        expect(response.status).toBe(202);
        return ((await response.json()) as { workspace: { id: string } }).workspace.id;
      }),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await workspacesNamed(testServer, "converged")).toHaveLength(1);

    const changed = await resume(testServer, sourceId, "converge", { ...body, template_version: "1.0.0" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: { code: "idempotency.conflict" } });
  });

  test("a retry while the first request is queuing gets its workspace or its error", async () => {
    const testServer = await server(await createStore());
    const { sourceId } = await preservedSource(testServer);
    await registerVersion(testServer, "1.1.0");
    const insert = testServer.store.insertWorkspace.bind(testServer.store);
    let queuing = false;
    let release: (queueFull: boolean) => void = () => {};
    testServer.store.insertWorkspace = async (row, options) => {
      queuing = true;
      const queueFull = await new Promise<boolean>((resolve) => {
        release = resolve;
      });
      return queueFull ? { kind: "capacity_exceeded" } : insert(row, options);
    };

    for (const [key, queueFull] of [
      ["queued", false],
      ["queue-full", true],
    ] as const) {
      queuing = false;
      const body = { external_id: key, template_version: "1.1.0" };
      const first = resume(testServer, sourceId, key, body);
      await waitFor(async () => queuing);
      const retry = resume(testServer, sourceId, key, body);
      await new Promise((resolve) => setTimeout(resolve, 100));
      release(queueFull);
      const answers = await Promise.all(
        [await first, await retry].map(async (response) => ({ status: response.status, body: await response.json() })),
      );
      if (queueFull) {
        for (const answer of answers)
          expect(answer).toMatchObject({ status: 429, body: { error: { code: "capacity.queue_full" } } });
        expect(await workspacesNamed(testServer, key)).toHaveLength(0);
      } else {
        expect(answers.map((answer) => answer.status)).toEqual([202, 202]);
        const [a, b] = answers.map((answer) => (answer.body as { workspace: { id: string } }).workspace.id);
        expect(a).toBe(b);
        expect(await workspacesNamed(testServer, key)).toHaveLength(1);
      }
    }
  });
});
