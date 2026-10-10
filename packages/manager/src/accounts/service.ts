import type { z } from "zod";
import type { BootstrapInputSchema } from "../config";
import type { ManagerStore } from "../database/store";
import { KubernetesAccounts } from "../kubernetes/accounts";
import { ManagerError } from "./errors";

export function accountService(store: ManagerStore, provider = new KubernetesAccounts()) {
  let reconciliation: Promise<void> | undefined;
  let stopping = false;
  const claims = new Map<string, Promise<unknown>>();
  return {
    reconcile() {
      if (reconciliation) return reconciliation;
      if (stopping) return Promise.resolve();
      reconciliation = (async () => {
        for (const operation of await store.pendingOperations()) {
          if (stopping) break;
          const account = await store.getAccount(operation.accountId);
          if (!account) throw new Error("Account missing");
          await store.startOperation(operation.id);
          try {
            await provider.ensure(account);
            await store.finishAccount(account.id, operation.id);
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
        .then(async () => {
          const account = await store.getAccount(accountId);
          if (!account) throw new ManagerError(404, "account_not_found");
          const request = await store.beginBootstrap(accountId, input, expiresAt);
          const result = await provider.owner(account, request);
          await store.completeBootstrap(request.id, result.key.id);
          return result;
        });
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
