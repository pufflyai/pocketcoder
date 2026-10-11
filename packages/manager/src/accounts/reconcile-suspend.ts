import type { Account, ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";

type Operation = NonNullable<Awaited<ReturnType<ManagerStore["getOperation"]>>>;
async function retainBackupRuntimes(store: ManagerStore, provider: KubernetesAccounts, account: Account) {
  const backups: Record<string, unknown> = {};
  for (const backup of await store.listBackups(account.id)) {
    if (backup.volumeName === account.volumeName)
      backups[backup.id] = await provider.backup.runtimeProof(account, backup.receipt);
  }
  return backups;
}
export async function reconcileSuspend(store: ManagerStore, provider: KubernetesAccounts, operation: Operation) {
  const account = await store.getAccount(operation.accountId);
  if (!account) throw new Error("Account missing.");
  if (operation.phase === "controller") {
    if (account.plan.offNodeBackups) await provider.stopController.prepare(account, operation, store);
    const result = await provider.lifecycle.perform(account, "suspend", operation.id);
    if (account.plan.offNodeBackups) {
      if (!result.compute_proof) throw new Error("Core runtime termination proof is missing.");
      const current = await store.getOperation(operation.id);
      const backups = await retainBackupRuntimes(store, provider, account);
      await store.saveComputeProof(operation.id, { ...current?.computeProof, runtime: result.compute_proof, backups });
    }
    await store.setOperationPhase(operation.id, "scale");
  }
  if (account.plan.offNodeBackups) {
    const current = await store.getOperation(operation.id);
    if (!current) throw new Error("Suspend operation is missing.");
    await provider.stopController.prepare(account, current, store);
    const prepared = await store.getOperation(operation.id);
    if (!prepared) throw new Error("Suspend operation is missing.");
    await provider.stopController.stop(account, prepared, store);
  } else await provider.lifecycle.scaleDown(account);
  await store.finishAccount(account.id, operation.id, "suspended");
}
