import { reconcileBackup, reconcileRestore } from "../backup/reconcile";
import type { ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";
import { reconcileSuspend } from "./reconcile-suspend";

export async function reconcileOperation(
  store: ManagerStore,
  provider: KubernetesAccounts,
  operation: Awaited<ReturnType<ManagerStore["pendingOperations"]>>[number],
) {
  const account = await store.getAccount(operation.accountId);
  if (!account) throw new Error("Account missing");
  if (operation.kind === "provision") {
    await provider.ensure(account);
    await store.finishAccount(account.id, operation.id);
    return;
  }
  if (operation.kind === "suspend") {
    await reconcileSuspend(store, provider, operation);
    return;
  }
  if (operation.kind === "backup") return reconcileBackup(store, provider, operation);
  if (operation.kind === "restore") return reconcileRestore(store, provider, operation);
  if (operation.phase === "controller") {
    await provider.lifecycle.scaleUp(account);
    await store.setOperationPhase(operation.id, "scale");
  }
  await provider.lifecycle.perform(account, "resume", operation.id);
  await store.finishAccount(account.id, operation.id);
}
