import type { ManagerStore } from "../database/store";
import type { KubernetesAccounts } from "../kubernetes/accounts";

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
    if (operation.phase === "controller") {
      await provider.lifecycle.perform(account, "suspend", operation.id);
      await store.setOperationPhase(operation.id, "scale");
    }
    await provider.lifecycle.scaleDown(account);
    await store.finishAccount(account.id, operation.id, "suspended");
    return;
  }
  if (operation.phase === "controller") {
    await provider.lifecycle.scaleUp(account);
    await store.setOperationPhase(operation.id, "scale");
  }
  await provider.lifecycle.perform(account, "resume", operation.id);
  await store.finishAccount(account.id, operation.id);
}
