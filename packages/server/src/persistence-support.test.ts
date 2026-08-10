import { afterEach, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { snapshotOf } from "@pstdio/pocketcoder-contracts";
import { FilesystemStorageDriver } from "@pstdio/pocketcoder-drivers";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS, type WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "./app";
import { DEFAULT_PERSISTENCE_LIMITS } from "./persistence";

const roots: string[] = [];
const pepper = "persistence-test-pepper";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

export async function server(options: { maxConcurrentOperations?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-persistence-api-"));
  roots.push(root);
  const store = new MemoryStore();
  const driver = new FakeDriver();
  const storageDriver = new FilesystemStorageDriver({
    workspaceRoot: join(root, "workspaces"),
    checkpointRoot: join(root, "checkpoints"),
  });
  const parsed = fixtureTemplatePersistent();
  await store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: parsed.manifest.metadata.description ?? null,
    spec: parsed.manifest.spec,
  });
  const scopes = [
    "templates:read",
    "workspaces:create",
    "workspaces:read",
    "workspaces:cancel",
    "workspaces:preserve",
    "workspaces:restore",
    "checkpoints:read",
    "checkpoints:delete",
    "outputs:read",
    "conversations:read",
    "conversations:delete",
    "services:relay",
    "logs:read",
  ];
  const principal = await store.createPrincipal("persistent-user", scopes, ["fixture-persistent"]);
  const key = issueMachineKey(pepper);
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  const built = buildServer({
    store,
    driver,
    storageDriver,
    pepper,
    limits: DEFAULT_LIMITS,
    persistenceLimits: {
      ...DEFAULT_PERSISTENCE_LIMITS,
      ...(options.maxConcurrentOperations === undefined
        ? {}
        : { maxConcurrentOperations: options.maxConcurrentOperations }),
    },
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  const request = (path: string, init: RequestInit = {}) =>
    built.app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${key.token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  return { ...built, store, driver, storageDriver, principal, parsed, request };
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition timed out");
}

export async function insertReadyCheckpoint(testServer: Awaited<ReturnType<typeof server>>) {
  const checkpointId = randomUUID();
  const now = new Date();
  await testServer.store.insertCheckpoint({
    id: checkpointId,
    workspaceId: randomUUID(),
    principalId: testServer.principal.id,
    storageId: randomUUID(),
    parentCheckpointId: null,
    state: "ready",
    reasonCode: null,
    providerKind: "filesystem",
    providerRef: { kind: "filesystem", id: checkpointId },
    templateSnapshot: snapshotOf(testServer.parsed),
    templateDigest: testServer.parsed.digest,
    sourceProvenance: null,
    manifest: {
      format: "pocketcoder-checkpoint/v1",
      checkpoint_id: checkpointId,
      template_digest: testServer.parsed.digest,
      mounts: [],
      logical_bytes: 0,
      file_count: 0,
    },
    manifestDigest: "sha256:fixture",
    logicalBytes: 0,
    storedBytes: 0,
    fileCount: 0,
    conversationRestore: "filesystem_only",
    label: null,
    createdAt: now,
    updatedAt: now,
    readyAt: now,
    expiresAt: null,
    deletedAt: null,
  });
  return checkpointId;
}

export async function assertSupportedResume(
  testServer: Awaited<ReturnType<typeof server>>,
  createdId: string,
  checkpoint: WorkspaceCheckpointRow,
) {
  const supportedCheckpoint = await testServer.store.insertCheckpoint({
    ...checkpoint,
    id: randomUUID(),
    parentCheckpointId: checkpoint.id,
    conversationRestore: "supported",
    label: "supported-resume-fixture",
    createdAt: new Date(checkpoint.createdAt.getTime() + 1),
    updatedAt: new Date(checkpoint.updatedAt.getTime() + 1),
    readyAt: new Date((checkpoint.readyAt ?? checkpoint.updatedAt).getTime() + 1),
  });
  const response = await testServer.request(`/v1/workspaces/${createdId}/resume`, {
    method: "POST",
    headers: { "idempotency-key": "resume-supported" },
    body: JSON.stringify({
      external_id: "resumed-conversation",
      launch_input: { bootstrap_token: "resume-envelope" },
    }),
  });
  expect(response.status).toBe(202);
  const body = (await response.json()) as { workspace: { id: string } };
  expect(body as unknown).toMatchObject({
    workspace: {
      external_id: "resumed-conversation",
      origin_workspace_id: createdId,
      restored_from_checkpoint_id: supportedCheckpoint.id,
    },
    resume: {
      status: "supported",
      reason: null,
      source_workspace_id: createdId,
      checkpoint_id: supportedCheckpoint.id,
    },
  });
  expect((await testServer.store.getWorkspace(body.workspace.id))?.launchInput).toEqual({
    bootstrap_token: "resume-envelope",
  });
}
