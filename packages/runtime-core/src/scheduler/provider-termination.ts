import type { WorkspaceDriver } from "../driver";
import type { WorkspaceRow, WorkspaceStore } from "../types";

type TerminationWorkspace = Pick<WorkspaceRow, "id" | "providerKind" | "providerRef">;

function sameProvider(current: TerminationWorkspace | null, expected: TerminationWorkspace) {
  return (
    current?.providerKind === expected.providerKind &&
    current?.providerRef?.id === expected.providerRef?.id &&
    current?.providerRef?.kind === expected.providerRef?.kind &&
    current?.providerRef?.namespace === expected.providerRef?.namespace &&
    current?.providerRef?.poolRuntimeId === expected.providerRef?.poolRuntimeId
  );
}

export async function stopWorkspaceProvider(
  store: Pick<WorkspaceStore, "updateWorkspace"> & { getWorkspace(id: string): Promise<TerminationWorkspace | null> },
  driver: Pick<WorkspaceDriver, "stop" | "remove" | "terminationEvidence">,
  workspace: TerminationWorkspace,
  graceSeconds: number,
  at: Date,
  remove = true,
) {
  if (!workspace.providerRef) return;
  const ref = { kind: workspace.providerKind ?? "", id: "", ...workspace.providerRef };
  let evidence: Record<string, unknown> | null | undefined;
  try {
    await driver.stop(ref, graceSeconds);
    evidence = await driver.terminationEvidence?.(ref);
  } catch (error) {
    // Another finalizer may have saved proof and removed its provider already.
    const current = await store.getWorkspace(workspace.id);
    if (!sameProvider(current, workspace) || !current?.providerRef?.terminationEvidence) throw error;
  }
  if (evidence) {
    const current = await store.getWorkspace(workspace.id);
    if (!current?.providerRef || !sameProvider(current, workspace)) throw new Error("Termination provider changed");
    await store.updateWorkspace(
      workspace.id,
      {
        providerRef: { ...current.providerRef, terminationEvidence: evidence },
      },
      at,
    );
  }
  // Persist before removal: a crash can always retry while the Job still holds
  // the proof; once removed, the runtime row is the durable source.
  if (remove) await driver.remove(ref);
}

export async function cleanupUncommittedProvider(
  driver: WorkspaceDriver,
  workspace: WorkspaceRow,
  graceSeconds: number,
) {
  // A provider may exist even when its create response or database write was lost.
  for (const found of await driver.list()) {
    if (found.workspaceId !== workspace.id) continue;
    if (found.templateDigest !== workspace.templateDigest) throw new Error("Uncommitted provider template mismatch");
    await driver.stop(found.ref, graceSeconds);
    await driver.remove(found.ref);
  }
  await driver.purgeInput(workspace.id);
}
