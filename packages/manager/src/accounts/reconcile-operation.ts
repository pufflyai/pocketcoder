import { reconcileBackup, reconcileRestore } from "../backup/reconcile";
import type { ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";
import { createRequestDigest } from "../purge/intent";
import { reconcileUpgrade } from "../upgrade/reconcile";
import { reconcileSuspend } from "./reconcile-suspend";

export async function reconcileOperation(
  store: ManagerStore,
  provider: KubernetesAccounts,
  operation: Awaited<ReturnType<ManagerStore["pendingOperations"]>>[number],
) {
  const account = await store.getAccount(operation.accountId);
  if (!account) throw new Error("Account missing");
  if (operation.kind === "provision") {
    if (store.purge) {
      await store.purge.history.start({
        accountId: account.id,
        createRequestDigest: createRequestDigest(account.requestId),
        originalCreateOperationId: operation.id,
      });
      // The permanent intent may arrive while the independent start receipt is being acknowledged.
      await store.getAccount(account.id);
    }
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
  if (operation.kind === "upgrade") return reconcileUpgrade(store, provider, operation);
  if (operation.phase === "controller") {
    await provider.lifecycle.scaleUp(account);
    await store.setOperationPhase(operation.id, "scale");
  }
  await provider.lifecycle.perform(account, "resume", operation.id);
  await store.finishAccount(account.id, operation.id);
}
