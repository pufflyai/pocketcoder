import type { ProviderRef, WorkspaceDriver } from "../driver";
import { sameProvider, stopWorkspaceProvider } from "../scheduler/provider-termination";
import type { Store, WarmPoolRuntimeRow } from "../types";

export async function cleanupWarmProvider(store: Store, driver: WorkspaceDriver, row: WarmPoolRuntimeRow, at: Date) {
  let ref = row.providerRef as ProviderRef | null;
  if (!ref) {
    if (driver.uncommittedWarmProvider) ref = await driver.uncommittedWarmProvider(row);
    else {
      if (driver.kind === "kubernetes") throw new Error("Kubernetes warm admission proof is unavailable");
      const found = (await driver.listWarm()).find((item) => item.runtimeId === row.id);
      if (found && found.templateDigest !== row.templateDigest) throw new Error("Warm provider template mismatch");
      ref = found?.ref ?? null;
    }
    if (ref) await store.updateWarmPoolRuntime(row.id, { providerRef: ref }, at);
  }
  if (!ref) return;
  if (row.workspaceId && !ref.terminationEvidence) {
    const workspace = await store.getWorkspace(row.workspaceId);
    const expected = { id: row.id, providerKind: row.driverKind, providerRef: ref };
    if (
      workspace?.templateDigest === row.templateDigest &&
      workspace.providerRef?.poolRuntimeId === row.id &&
      sameProvider(workspace, expected) &&
      workspace.providerRef.terminationEvidence
    ) {
      ref = { ...ref, terminationEvidence: workspace.providerRef.terminationEvidence };
      await store.updateWarmPoolRuntime(row.id, { providerRef: ref }, at);
    }
  }

  await stopWorkspaceProvider(
    {
      async getWorkspace(id) {
        const current = await store.getWarmPoolRuntime(id);
        return current ? { id, providerKind: current.driverKind, providerRef: current.providerRef } : null;
      },
      async updateWorkspace(id, patch, now) {
        await store.updateWarmPoolRuntime(id, { providerRef: patch.providerRef }, now);
      },
    },
    driver,
    { id: row.id, providerKind: row.driverKind, providerRef: ref },
    1,
    at,
  );
}
