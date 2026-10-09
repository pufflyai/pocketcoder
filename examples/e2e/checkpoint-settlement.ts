import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";

async function assertFailedCapture(
  store: PGliteStore,
  rejected: { workspaceId: string; checkpointId: string; operationId: string },
) {
  const checkpoint = await store.getCheckpoint(rejected.checkpointId);
  const operation = await store.getOperation(rejected.operationId);
  const workspace = await store.getWorkspace(rejected.workspaceId);
  if (
    checkpoint?.state !== "failed" ||
    checkpoint.providerKind !== "controller-archive" ||
    checkpoint.readyAt ||
    checkpoint.providerRef ||
    (await store.checkpointTransfers.publication(rejected.checkpointId)) ||
    operation?.state !== "failed" ||
    !operation.completedAt ||
    workspace?.state !== "canceled"
  ) {
    throw new Error("Rejected capture did not settle without a durable archive");
  }
}

export async function assertCheckpointSettlement(input: {
  dataDir: string;
  checkpointDir: string;
  sourceId: string;
  destinationId: string;
  checkpointId: string;
  restoreOperationId: string;
  sourceStoppedAt: number;
  rejectedCapture: { workspaceId: string; checkpointId: string; operationId: string };
}) {
  const store = await PGliteStore.create(input.dataDir);
  try {
    await store.init();
    const checkpoint = await store.getCheckpoint(input.checkpointId);
    const publication = await store.checkpointTransfers.publication(input.checkpointId);
    if (checkpoint?.state !== "ready" || publication?.state !== "complete" || !checkpoint.readyAt) {
      throw new Error("Preserved archive has no durable publication receipt");
    }
    if (checkpoint.readyAt.getTime() > input.sourceStoppedAt) {
      throw new Error("Source stopped before durable checkpoint publication");
    }
    if (publication.grantDigest !== null) throw new Error("Upload grant survived settlement");
    const archivePath = checkpoint.providerRef?.archivePath;
    if (
      typeof archivePath !== "string" ||
      JSON.stringify(await readdir(input.checkpointDir)) !== JSON.stringify([archivePath])
    ) {
      throw new Error("Temporary checkpoint storage survived normal completion");
    }
    const archive = await stat(join(input.checkpointDir, archivePath), { bigint: true });
    const allocatedBytes = Number(archive.blocks) * 512;
    const reservation = await store.storageReservations.get(publication.reservationId ?? "");
    if (
      reservation?.state !== "committed" ||
      reservation.materializedBytes !== allocatedBytes ||
      reservation.materializedFiles !== 1 ||
      Number(archive.size) !== publication.storedBytes
    ) {
      throw new Error("Durable archive allocation did not settle exactly");
    }
    const usage = await store.storageReservations.usage(null, null);
    if (
      usage.outstanding.bytes !== 0 ||
      usage.outstanding.files !== 0 ||
      usage.instance.bytes !== allocatedBytes ||
      usage.instance.files !== 1
    ) {
      throw new Error("Temporary storage or duplicate archive charge survived normal completion");
    }
    const operation = await store.getOperation(input.restoreOperationId);
    const destination = await store.getWorkspace(input.destinationId);
    if (
      operation?.state !== "succeeded" ||
      !operation.completedAt ||
      !destination?.readyAt ||
      operation.completedAt < destination.readyAt
    ) {
      throw new Error("Restore succeeded before verified destination readiness");
    }
    if (destination.state !== "canceled") throw new Error("Destination did not finish normal teardown before shutdown");
    const rejected = input.rejectedCapture;
    await assertFailedCapture(store, rejected);
    for (const id of [input.sourceId, input.destinationId, rejected.workspaceId]) {
      const workspace = await store.getWorkspace(id);
      const storage = await store.listWorkspaceStorage(id);
      if (
        workspace?.registrationDigest ||
        workspace?.registrationExpiresAt ||
        workspace?.reconnectDigest ||
        storage.length !== 1 ||
        storage.some((allocation) => allocation.state !== "deleted" || !allocation.deletedAt)
      ) {
        throw new Error("Runtime authority or disposable storage survived normal teardown");
      }
    }
    return {
      storedBytes: publication.storedBytes,
      allocatedBytes,
      reservationState: reservation.state,
      outstandingBytes: 0,
    };
  } finally {
    await store.close();
  }
}
