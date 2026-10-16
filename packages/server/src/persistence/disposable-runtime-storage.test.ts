import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, snapshotOf } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { KubernetesSharedStorage } from "@pstdio/pocketcoder-drivers";
import { fixtureTemplatePersistent } from "@pstdio/pocketcoder-testkit";
import { prepareDisposableRuntimeStorage } from "./disposable-runtime-storage";

const createStore = createTestStoreFactory();
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

for (const provider of ["filesystem", "kubernetes", "kubernetes-shared"] as const) {
  test(`${provider} admits fresh restore mounts without cloning or completing the operation`, async () => {
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
    let shared: KubernetesSharedStorage | undefined;
    if (provider === "kubernetes-shared") {
      const root = await mkdtemp(join(tmpdir(), "pc-shared-store-"));
      roots.push(root);
      shared = new KubernetesSharedStorage({
        root: join(root, "shared"),
        checkpointRoot: join(root, "checkpoints"),
        claimName: "shared",
        volumeName: "shared-pv",
        storageClassName: "qualified-nfs",
        networkPolicyName: "isolate-storage",
        storageCidrs: ["192.0.2.1/32"],
        profile: "shared-writer-readonly/v1",
        maxBytes: 1024 ** 3,
        maxFiles: 10000,
      });
    }
    const mounts = await prepareDisposableRuntimeStorage(store, provider, inserted.workspace, at, shared);
    const storage = await store.getWorkspaceStorage(workspaceId);
    if (!storage) throw new Error("Shared or disposable allocation was not recorded");
    expect(mounts).toEqual(
      parsed.manifest.spec.persistence.mounts.map((mount) => {
        if (shared)
          return {
            name: mount.name,
            target: mount.target,
            source: { kind: "shared-filesystem", allocationId: storage.id, directory: mount.name },
          };
        return {
          name: mount.name,
          target: mount.target,
          source:
            provider === "kubernetes"
              ? { kind: "empty-dir", maxBytes: mount.maxBytes }
              : {
                  kind: "tmpfs",
                  maxBytes: mount.maxBytes,
                  uid: parsed.manifest.spec.security.uid,
                  gid: parsed.manifest.spec.security.gid,
                },
        };
      }),
    );
    expect(storage?.state).toBe("restoring");
    if (shared) expect(storage?.providerRef.kind).toBe("kubernetes-shared");
    else
      expect(storage?.providerRef).toEqual({
        kind: provider === "kubernetes" ? "empty-dir" : "tmpfs",
        id: storage?.id,
      });
    expect((await store.getOperation(operationId))?.state).toBe("pending");
    expect(await prepareDisposableRuntimeStorage(store, provider, inserted.workspace, at, shared)).toEqual(mounts);
    expect((await store.getWorkspaceStorage(workspaceId))?.id).toBe(storage?.id);
  });
}
