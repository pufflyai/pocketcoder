import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { DEFAULT_PERSISTENCE_LIMITS } from "./persistence";

const pepper = "postgres-route-test-pepper";

async function waitFor(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

async function removeStorageRoot(root: string) {
  async function makeWritable(path: string): Promise<void> {
    await chmod(path, 0o700).catch(() => {});
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await makeWritable(child);
      else await chmod(child, 0o600).catch(() => {});
    }
  }

  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

describe.each(["memory", "disk"] as const)("PGlite persistence routes (%s)", (mode) => {
  let root: string;
  let store: PGliteStore;
  let server: ReturnType<typeof buildServer>;
  let storageDriver: FilesystemStorageDriver;
  let request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  let created: { id: string };
  let sourceStorageId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pocketcoder-postgres-routes-"));
    store = await PGliteStore.create(mode === "disk" ? join(root, "pc_data") : undefined);
  });

  afterAll(async () => {
    await store?.close();
    if (root) await removeStorageRoot(root);
  });

  beforeAll(async () => {
    const parsed = fixtureTemplatePersistent();
    await store.upsertTemplate({
      name: parsed.manifest.metadata.name,
      version: parsed.manifest.spec.version,
      digest: parsed.digest,
      description: parsed.manifest.metadata.description ?? null,
      spec: parsed.manifest.spec,
    });
    const principal = await store.createPrincipal("postgres-route-user", ["admin"], ["*"]);
    const key = issueMachineKey(pepper);
    await store.insertMachineKey({
      id: key.id,
      principalId: principal.id,
      secretDigest: key.secretDigest,
      scopes: [],
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });

    const driver = new FakeDriver();
    storageDriver = new FilesystemStorageDriver({
      workspaceRoot: join(root, "workspaces"),
      checkpointRoot: join(root, "checkpoints"),
    });
    server = buildServer({
      store,
      driver,
      storageDriver,
      pepper,
      limits: DEFAULT_LIMITS,
      persistenceLimits: DEFAULT_PERSISTENCE_LIMITS,
      workspaceServerUrl: "http://127.0.0.1:0",
    });
    request = (path: string, init: RequestInit = {}) =>
      server.app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${key.token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    const createResponse = await request("/v1/workspaces", {
      method: "POST",
      headers: { "idempotency-key": "postgres-create" },
      body: JSON.stringify({
        external_id: "postgres-source",
        template: { name: "fixture-persistent" },
      }),
    });
    expect(createResponse.status).toBe(201);
    created = (await createResponse.json()) as { id: string };
    await server.scheduler.tick();
    await waitFor(async () => (await store.getWorkspaceStorage(created.id))?.state === "ready");
    const now = new Date();
    await store.transition(created.id, { from: ["provisioning"], to: "connected", at: now });
    await store.transition(created.id, {
      from: ["connected"],
      to: "ready",
      at: now,
      patch: { readyAt: now, lastActivityAt: now },
    });
    const sourceStorage = await store.getWorkspaceStorage(created.id);
    if (!sourceStorage) throw new Error("missing source allocation");
    sourceStorageId = sourceStorage.id;
    const sourceRoot = String(sourceStorage?.providerRef.root);
    await mkdir(join(sourceRoot, "worktree"), { recursive: true });
    await writeFile(join(sourceRoot, "worktree", "state.txt"), "preserved\n");
  });

  test("preserve, restore, and cleanup keep forks and foreign-key targets valid", async () => {
    const preserveResponse = await request(`/v1/workspaces/${created.id}/preserve`, {
      method: "POST",
      headers: { "idempotency-key": "postgres-preserve" },
      body: JSON.stringify({ label: "postgres-route" }),
    });
    expect(preserveResponse.status).toBe(202);
    const preserved = (await preserveResponse.json()) as {
      checkpoint: { id: string };
      operation: { id: string };
    };
    await waitFor(async () => (await store.getOperation(preserved.operation.id))?.state === "succeeded");
    const preserveOperation = await store.getOperation(preserved.operation.id);
    expect(preserveOperation?.checkpointId).toBe(preserved.checkpoint.id);
    expect(await store.getCheckpoint(preserveOperation?.checkpointId ?? "")).not.toBeNull();

    const restoreResponse = await request(`/v1/checkpoints/${preserved.checkpoint.id}/restore`, {
      method: "POST",
      headers: { "idempotency-key": "postgres-restore" },
      body: JSON.stringify({ external_id: "postgres-restored" }),
    });
    expect(restoreResponse.status).toBe(202);
    const restored = (await restoreResponse.json()) as {
      workspace: { id: string };
      operation: { id: string };
    };
    // Restore starts admission in the background. Join it before closing the database.
    await server.scheduler.tick();
    const restoreOperation = await store.getOperation(restored.operation.id);
    expect(restoreOperation?.state).toBe("succeeded");
    expect(restoreOperation?.resultWorkspaceId).toBe(restored.workspace.id);
    expect(await store.getWorkspace(restoreOperation?.resultWorkspaceId ?? "")).not.toBeNull();
    const deleted = await request(`/v1/checkpoints/${preserved.checkpoint.id}`, {
      method: "DELETE",
      headers: { "idempotency-key": "postgres-delete-checkpoint" },
    });
    expect(deleted.status).toBe(202);
    expect(await deleted.json()).toMatchObject({ state: "succeeded" });
    const removed = await request(`/v1/checkpoints/${preserved.checkpoint.id}`);
    expect(removed.status).toBe(404);
    expect(await removed.json()).toMatchObject({ error: { code: "checkpoint.not_found" } });
    expect((await store.getCheckpoint(preserved.checkpoint.id))?.state).toBe("deleted");
    expect((await store.getStorage(sourceStorageId))?.state).toBe("deleted");
    const forkStorage = await store.getWorkspaceStorage(restored.workspace.id);
    if (!forkStorage) throw new Error("missing restored allocation");
    expect(forkStorage?.state).toBe("ready");
    expect(await readFile(join(String(forkStorage?.providerRef.root), "worktree", "state.txt"), "utf8")).toBe(
      "preserved\n",
    );
    expect((await storageDriver.listStorage()).map((item) => item.storageId)).toEqual([forkStorage?.id]);
    expect(await storageDriver.listCheckpoints()).toEqual([]);
  });
});
