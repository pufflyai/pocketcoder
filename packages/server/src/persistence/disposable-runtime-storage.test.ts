import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { prepareDisposableRuntimeStorage } from "./disposable-runtime-storage";

const createStore = createTestStoreFactory();

test("admits fresh restore mounts without cloning or completing the operation", async () => {
  const store = await createStore();
  const principal = await store.createPrincipal("disposable-owner", ["admin"], ["*"]);
  const parsed = fixtureTemplatePersistent();
  const template = (
    await store.upsertTemplate({
      name: parsed.manifest.metadata.name,
      version: parsed.manifest.spec.version,
      digest: parsed.digest,
      description: null,
      spec: parsed.manifest.spec,
    })
  ).row;
  const at = new Date();
  const workspaceId = randomUUID();
  const checkpointId = randomUUID();
  const inserted = await store.insertWorkspace({
    id: workspaceId,
    principalId: principal.id,
    externalId: workspaceId,
    idempotencyKey: workspaceId,
    requestDigest: digestOf({ workspaceId }),
    templateId: template.id,
    templateSnapshot: snapshotOf(parsed),
    launchInput: null,
    metadata: {},
    createdAt: at,
    deadlineAt: new Date(at.getTime() + 60_000),
    launchMode: "restore",
    originWorkspaceId: randomUUID(),
    restoredFromCheckpointId: checkpointId,
  });
  if (inserted.kind !== "created") throw new Error(`Unexpected insert: ${inserted.kind}`);
  const operationId = randomUUID();
  await store.insertOperation({
    id: operationId,
    principalId: principal.id,
    kind: "restore",
    state: "pending",
    idempotencyKey: operationId,
    requestDigest: digestOf({ operationId }),
    workspaceId,
    checkpointId: null,
    resultWorkspaceId: workspaceId,
    reasonCode: null,
    attemptCount: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
  });
  const mounts = await prepareDisposableRuntimeStorage(store, "filesystem", inserted.workspace, at);
  expect(mounts).toEqual(
    parsed.manifest.spec.persistence.mounts.map((mount) => ({
      name: mount.name,
      target: mount.target,
      source: {
        kind: "tmpfs",
        maxBytes: mount.maxBytes,
        uid: parsed.manifest.spec.security.uid,
        gid: parsed.manifest.spec.security.gid,
      },
    })),
  );
  const storage = await store.getWorkspaceStorage(workspaceId);
  expect(storage?.state).toBe("restoring");
  expect(storage?.providerRef).toEqual({ kind: "tmpfs", id: storage?.id });
  expect((await store.getOperation(operationId))?.state).toBe("pending");
  expect(await prepareDisposableRuntimeStorage(store, "filesystem", inserted.workspace, at)).toEqual(mounts);
  expect((await store.getWorkspaceStorage(workspaceId))?.id).toBe(storage?.id);
});
