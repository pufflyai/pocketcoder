import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { preservedSource, registerVersion, resume, server, waitFor } from "./persistence-support.test";

const createStore = createTestStoreFactory();
type TestServer = Awaited<ReturnType<typeof server>>;

const UPGRADED_IMAGE = `example.test/fixture-persistent@sha256:${"c".repeat(64)}`;

// Resumes the source while the provider refuses every launch, like a cluster that no longer admits the image.
async function refusedResume(testServer: TestServer, sourceId: string) {
  testServer.driver.refuseLaunches = true;
  const response = await resume(testServer, sourceId, "refused", { external_id: "refused" });
  expect(response.status).toBe(202);
  const { workspace } = (await response.json()) as { workspace: { id: string } };
  await waitFor(async () => {
    await testServer.scheduler.tick();
    await testServer.scheduler.sweep();
    return (await testServer.store.getWorkspace(workspace.id))?.reasonCode === "launch_refused";
  });
  testServer.driver.refuseLaunches = false;
  return workspace.id;
}

async function resumed(testServer: TestServer, sourceId: string) {
  const response = await resume(testServer, sourceId, "healed", { external_id: "healed" });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function retire(testServer: TestServer, version: string) {
  const admin = await testServer.store.createPrincipal(`admin-${randomUUID()}`, ["admin"], ["*"]);
  const actor = randomUUID();
  await testServer.store.insertMachineKey({
    id: actor,
    principalId: admin.id,
    secretDigest: new Uint8Array(32),
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  await testServer.store.retireTemplate(actor, "fixture-persistent", version);
}

describe("resume heals a conversation whose saved template cannot launch", () => {
  test("a resumed workspace that never started resumes from the checkpoint it was restored from", async () => {
    const testServer = await server(await createStore());
    const { sourceId, checkpointId } = await preservedSource(testServer);
    const refusedId = await refusedResume(testServer, sourceId);

    expect(await resumed(testServer, refusedId)).toMatchObject({
      status: 202,
      body: {
        workspace: { template: { version: "1.0.0" }, restored_from_checkpoint_id: checkpointId },
        resume: { status: "supported", source_workspace_id: refusedId, checkpoint_id: checkpointId },
      },
    });
  });

  test("after a refused launch, resume moves to the newest compatible version", async () => {
    const testServer = await server(await createStore());
    const { sourceId } = await preservedSource(testServer);
    const upgraded = await registerVersion(testServer, "1.1.0", (spec) => {
      spec.image = UPGRADED_IMAGE;
    });
    await registerVersion(testServer, "2.0.0-moved", (spec) => {
      for (const mount of spec.persistence.mounts) mount.target = "/moved";
    });
    const refusedId = await refusedResume(testServer, sourceId);

    expect(await resumed(testServer, refusedId)).toMatchObject({
      status: 202,
      body: { workspace: { template: { version: "1.1.0", digest: upgraded.digest } } },
    });
  });

  test("a retired checkpoint version resumes onto the newest compatible version", async () => {
    const testServer = await server(await createStore());
    const { sourceId } = await preservedSource(testServer);
    await registerVersion(testServer, "1.1.0", (spec) => {
      spec.image = UPGRADED_IMAGE;
    });
    await retire(testServer, "1.0.0");

    expect(await resumed(testServer, sourceId)).toMatchObject({
      status: 202,
      body: { workspace: { template: { version: "1.1.0" } } },
    });
  });

  test("with only incompatible newer versions, resume after a refused launch says why", async () => {
    const testServer = await server(await createStore());
    const { sourceId } = await preservedSource(testServer);
    await registerVersion(testServer, "2.0.0-session", (spec) => {
      spec.persistence.sessionCompatibility = "fixture/v2";
    });
    const refusedId = await refusedResume(testServer, sourceId);

    expect(await resumed(testServer, refusedId)).toMatchObject({
      status: 409,
      body: { error: { code: "restore.incompatible", details: { reason: "session_format" } } },
    });
  });
});
