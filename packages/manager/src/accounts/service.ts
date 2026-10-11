import type { z } from "zod";
import type { BootstrapInputSchema } from "../config";
import type { ManagerStore } from "../database/store";
import { KubernetesAccounts } from "../kubernetes/accounts";
import { purgeAdmission } from "../purge/admission";
import type { PhysicalStorage } from "../purge/provider-types";
import { ManagerError } from "./errors";
import { reconcileOperation } from "./reconcile-operation";

export function accountService(store: ManagerStore, provider = new KubernetesAccounts(), physical?: PhysicalStorage) {
  let reconciliation: Promise<void> | undefined;
  let stopping = false;
  const claims = new Map<string, Promise<unknown>>();
  const admitPurge = store.purge ? purgeAdmission(store, store.purge) : undefined;
  return {
    async purge(accountId: string, requestId: string, expiresAt: Date) {
      if (stopping) throw new ManagerError(409, "manager_stopping");
      if (!admitPurge) throw new ManagerError(409, "purge_not_configured");
      const operation = await admitPurge(accountId, requestId, expiresAt);
      return (await store.purgeRuntime?.status(operation.id)) ?? operation;
    },
    reconcile() {
      if (reconciliation) return reconciliation;
      if (stopping) return Promise.resolve();
      reconciliation = (async () => {
        await store.purgeRuntime?.reconcile(
          (intent) => provider.purgeNamespaces(intent),
          store.purge && physical ? provider.physicalPurge(physical, store.purge) : undefined,
        );
        for (const operation of await store.pendingOperations()) {
          if (stopping) break;
          await store.startOperation(operation.id);
          try {
            await store.runAccountWork(operation.accountId, () => reconcileOperation(store, provider, operation));
          } catch {
            await store.recordError(operation.id);
          }
        }
      })().finally(() => {
        reconciliation = undefined;
      });
      return reconciliation;
    },
    async bootstrap(accountId: string, input: z.infer<typeof BootstrapInputSchema>, expiresAt: Date) {
      if (stopping) throw new ManagerError(409, "manager_stopping");
      // Only one local writer holds the manager folder; serialize each account's private admin calls.
      const previous = claims.get(accountId) ?? Promise.resolve();
      const current = previous
        .catch(() => {})
        .then(() =>
          store.runAccountWork(accountId, async () => {
            const account = await store.getAccount(accountId);
            if (!account) throw new ManagerError(404, "account_not_found");
            const request = await store.beginBootstrap(accountId, input, expiresAt);
            const result = await provider.owner(account, request);
            await store.completeBootstrap(request.id, result.key.id);
            return result;
          }),
        );
      claims.set(accountId, current);
      try {
        return await current;
      } finally {
        if (claims.get(accountId) === current) claims.delete(accountId);
      }
    },
    async close() {
      stopping = true;
      await Promise.allSettled([reconciliation, ...claims.values()]);
    },
  };
}
