import type { ProviderRef } from "../driver";
import type { ReconcileDeps } from "./reconcile";

interface Owner {
  label: string;
  id: string;
  templateDigest: string;
  providerKind: string | null;
  providerRef: Record<string, unknown> | null;
  save(providerRef: ProviderRef): Promise<void>;
}

// Cleanup needs the provider identity that older releases did not save. Recover it
// before the scheduler runs. An unproved identity only blocks its own cleanup.
export async function recoverLegacyProviders(deps: Pick<ReconcileDeps, "store" | "driver" | "log">, now: Date) {
  const { store, driver } = deps;
  if (!driver.legacyProvider) return;
  const owners: Owner[] = [
    ...(await store.listNonterminal()).map((row) => ({
      label: "workspace",
      id: row.id,
      templateDigest: row.templateDigest,
      providerKind: row.providerKind,
      providerRef: row.providerRef,
      save: (providerRef: ProviderRef) => store.updateWorkspace(row.id, { providerRef }, now),
    })),
    ...(await store.listWarmPoolRuntimes())
      .filter((row) => row.state !== "failed")
      .map((row) => ({
        label: "warm runtime",
        id: row.id,
        templateDigest: row.templateDigest,
        providerKind: row.driverKind,
        providerRef: row.providerRef,
        save: (providerRef: ProviderRef) => store.updateWarmPoolRuntime(row.id, { providerRef }, now),
      })),
  ];
  for (const owner of owners) {
    if (owner.providerKind !== driver.kind || !owner.providerRef) continue;
    try {
      const recovered = await driver.legacyProvider(owner.providerRef as ProviderRef, owner);
      if (!recovered) continue;
      await owner.save(recovered);
      deps.log?.(`reconcile: recovered provider identity for ${owner.label} ${owner.id}`);
    } catch (error) {
      deps.log?.(`reconcile: provider identity for ${owner.label} ${owner.id} is unproved: ${String(error)}`);
    }
  }
}
