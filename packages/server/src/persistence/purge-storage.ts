import type {
  DiscoveredCheckpoint,
  DiscoveredStorage,
  StorageRef,
  WorkspaceCheckpointRow,
  WorkspaceRow,
  WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { PersistenceContext } from "./persistence-base";

export class PurgeOwnershipError extends Error {}

function storageTargets(workspace: WorkspaceRow, allocations: WorkspaceStorageRow[], physical: DiscoveredStorage[]) {
  const ids = new Set(allocations.map((row) => row.id));
  if (physical.some((row) => row.workspaceId === workspace.id && !ids.has(row.storageId))) {
    throw new PurgeOwnershipError("Unrecorded workspace allocation");
  }
  return allocations.map((allocation) => {
    const found = physical.find((row) => row.storageId === allocation.id);
    if (
      allocation.principalId !== workspace.principalId ||
      allocation.state === "quarantined" ||
      (found?.workspaceId && found.workspaceId !== workspace.id)
    ) {
      throw new PurgeOwnershipError("Storage ownership is unresolved");
    }
    const ref = Object.keys(allocation.providerRef).length ? allocation.providerRef : found?.ref;
    if (ref && ref.id !== allocation.id) throw new PurgeOwnershipError("Mismatched allocation reference");
    return { id: allocation.id, ref: ref as StorageRef | undefined };
  });
}

function checkpointTargets(
  checkpoints: WorkspaceCheckpointRow[],
  physical: DiscoveredCheckpoint[],
  storageIds: Set<string>,
) {
  return checkpoints.map((checkpoint) => {
    if (!storageIds.has(checkpoint.storageId))
      throw new PurgeOwnershipError("Checkpoint storage ownership is unresolved");
    const ref = checkpoint.providerRef ?? physical.find((row) => row.checkpointId === checkpoint.id)?.ref;
    if (ref && ref.id !== checkpoint.id) throw new PurgeOwnershipError("Mismatched checkpoint reference");
    return { id: checkpoint.id, ref: ref as StorageRef | undefined };
  });
}

export async function purgeStorage(context: PersistenceContext, workspace: WorkspaceRow) {
  const { store, storageDriver } = context.deps;
  const allocations = await store.listWorkspaceStorage(workspace.id);
  const checkpoints = await store.listCheckpoints(workspace.principalId, { workspaceId: workspace.id });
  if (!storageDriver) {
    if (allocations.length || checkpoints.length || workspace.templateSnapshot.spec.persistence.mounts.length) {
      throw new Error("Storage driver unavailable");
    }
    return;
  }
  const physicalStorage = await storageDriver.listStorage();
  const physicalCheckpoints = await storageDriver.listCheckpoints();
  const allocationIds = new Set(allocations.map((row) => row.id));
  // Resolve and check every owned target before deleting anything. Independent
  // descendants keep their separate allocations and must be purged by the owner.
  const storage = storageTargets(workspace, allocations, physicalStorage);
  const snapshots = checkpointTargets(checkpoints, physicalCheckpoints, allocationIds);
  for (const checkpoint of snapshots) {
    if (checkpoint.ref) await storageDriver.deleteCheckpoint(checkpoint.ref);
    await store.updateCheckpoint(checkpoint.id, { state: "deleted", deletedAt: context.now() }, context.now());
  }
  for (const allocation of storage) {
    if (allocation.ref) await storageDriver.deleteStorage(allocation.ref);
    await store.updateWorkspaceStorage(
      allocation.id,
      { state: "deleted", deletedAt: context.now(), retainedUntil: null, lastErrorCode: null },
      context.now(),
    );
  }
  const checkpointIds = new Set(checkpoints.map((row) => row.id));
  const remainingStorage = (await storageDriver.listStorage()).some(
    (row) => allocationIds.has(row.storageId) || row.workspaceId === workspace.id,
  );
  const remainingCheckpoints = (await storageDriver.listCheckpoints()).some((row) =>
    checkpointIds.has(row.checkpointId),
  );
  if (remainingStorage || remainingCheckpoints) throw new Error("Storage deletion not verified");
}
