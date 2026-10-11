import { runtimeIdentity } from "@pstdio/pocketcoder-db/off-node";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { AccountState, accountState } from "./account-state";

export async function retainDrainInventory(state: Awaited<ReturnType<typeof accountState>>, store: Store) {
  const current = state.state.compute;
  const workspaces = (await store.listNonterminal()).map((row) => row.id);
  const warm = (await store.listWarmPoolRuntimes()).filter((row) => row.state !== "failed").map((row) => row.id);
  const compute = {
    workspaces: [...new Set([...(current?.workspaces ?? []), ...workspaces])],
    warm: [...new Set([...(current?.warm ?? []), ...warm])],
    evidence: current?.evidence ?? [],
  };
  await state.save({ ...state.state, compute });
}

function evidence(kind: string, id: string, provider: string | null, ref: Record<string, unknown> | null) {
  if (provider === "kubernetes" && ref && !ref.terminationEvidence)
    throw new Error("Runtime termination proof is missing.");
  // Provider input and delegated grants never enter the manager's evidence.
  return {
    kind,
    id,
    provider,
    admitted: ref !== null,
    ref: provider === "kubernetes" && ref ? runtimeIdentity(kind as "workspace" | "warm", id, provider, ref).ref : null,
    termination: ref?.terminationEvidence ?? null,
  };
}

export async function completedDrainInventory(compute: AccountState["compute"], store: Store) {
  if (!compute) throw new Error("Runtime drain inventory is missing.");
  const proofs: Record<string, unknown>[] = [];
  for (const id of compute.workspaces) {
    const row = await store.getWorkspace(id);
    if (!row) throw new Error("Drained workspace is missing.");
    proofs.push(evidence("workspace", id, row.providerKind, row.providerRef));
  }
  for (const id of compute.warm) {
    const row = await store.getWarmPoolRuntime(id);
    if (!row) throw new Error("Drained warm runtime is missing.");
    proofs.push(evidence("warm", id, row.driverKind, row.providerRef));
  }
  return { ...compute, evidence: proofs };
}
