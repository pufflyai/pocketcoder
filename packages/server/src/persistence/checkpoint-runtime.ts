import type {
  Store,
  WorkspaceDriver,
  WorkspaceStorageDriver,
  WorkspaceTransferRuntime,
} from "@pstdio/pocketcoder-runtime-core";
import type { Hub } from "../control-channel/hub";
import { createCheckpointTransferService } from "./checkpoint-transfer";
import { prepareDisposableRuntimeStorage } from "./disposable-runtime-storage";

export type CheckpointTransferOptions = Omit<Parameters<typeof createCheckpointTransferService>[0], "store" | "hub">;

export function composeCheckpointRuntime(
  store: Store,
  hub: Hub,
  driver: WorkspaceDriver,
  storageDriver: WorkspaceStorageDriver | undefined,
  options: CheckpointTransferOptions | undefined,
) {
  if (!options) return {};
  if (driver.kind !== "docker" || storageDriver?.kind !== "filesystem") {
    throw new Error("Checkpoint transfers require the Docker driver and configured filesystem persistence");
  }
  const checkpointTransfers = createCheckpointTransferService({ ...options, store, hub });
  const transferRuntime: WorkspaceTransferRuntime = {
    prepareStorage: (workspace) => prepareDisposableRuntimeStorage(store, storageDriver.kind, workspace, new Date()),
    cleanupWorkspace: async (workspace) => {
      await checkpointTransfers.cleanup(workspace.id);
      const storage = await store.getWorkspaceStorage(workspace.id);
      if (storage && storage.state !== "deleted") {
        const at = new Date();
        await store.updateWorkspaceStorage(storage.id, { state: "deleted", deletedAt: at, retainedUntil: null }, at);
      }
      await store.updateWorkspace(
        workspace.id,
        { registrationDigest: null, registrationExpiresAt: null, reconnectDigest: null },
        new Date(),
      );
      await driver.purgeInput(workspace.id);
    },
  };
  return { checkpointTransfers, transferRuntime };
}
