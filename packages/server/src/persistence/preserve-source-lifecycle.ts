import {
  MAX_CHECKPOINT_PRESERVATION_MS,
  type WorkspaceRow,
  type WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-core";
import type { PersistenceContext } from "./persistence-base";

export async function cleanupTransferAuthority(context: PersistenceContext, workspace: WorkspaceRow) {
  const { store, driver, hub, checkpointTransfers } = context.deps;
  await context.deps.revokeWorkspaceLeases?.(workspace.id);
  await checkpointTransfers?.cleanup(workspace.id);
  await driver.purgeInput(workspace.id);
  hub.close(workspace.id);
  await store.updateWorkspace(
    workspace.id,
    {
      registrationDigest: null,
      registrationExpiresAt: null,
      reconnectDigest: null,
      launchInput: null,
    },
    context.now(),
  );
}

export async function retainUnpublishedSource(
  context: PersistenceContext,
  workspace: WorkspaceRow,
  storage: WorkspaceStorageRow,
  reason: "checkpoint_failed" | "checkpoint_quota_exceeded",
) {
  await cleanupTransferAuthority(context, workspace);
  const at = context.now();
  // Recovery is separate from transfer authority: no grant survives this finite window.
  await context.deps.store.updateWorkspaceStorage(
    storage.id,
    {
      state: "retained",
      retainedUntil: new Date(at.getTime() + MAX_CHECKPOINT_PRESERVATION_MS),
      lastErrorCode: reason,
    },
    at,
  );
}
