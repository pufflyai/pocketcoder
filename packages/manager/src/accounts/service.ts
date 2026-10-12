import type { z } from "zod";
import type { BootstrapInputSchema } from "../config";
import type { ManagerStore } from "../database/store";
import { KubernetesAccounts } from "../kubernetes/accounts";
import { purgeAdmission } from "../purge/admission";
import type { PhysicalStorage } from "../purge/provider-types";
import { resolveUpgrade } from "../upgrade/admission";
import { ManagerError } from "./errors";
import { reconcileOperation } from "./reconcile-operation";
import { serialAccountWork } from "./serial-work";

export function accountService(store: ManagerStore, provider = new KubernetesAccounts(), physical?: PhysicalStorage) {
  let reconciliation: Promise<void> | undefined;
  let stopping = false;
  const claims = serialAccountWork();
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
          await claims.run(operation.accountId, async () => {
            try {
              await store.runAccountWork(operation.accountId, async () => {
                const current = await store.getOperation(operation.id);
                if (!current || current.state === "succeeded") return;
                await store.startOperation(current.id);
                await reconcileOperation(store, provider, current);
              });
            } catch {
              await store.recordError(operation.id);
            }
          });
        }
      })().finally(() => {
        reconciliation = undefined;
      });
      return reconciliation;
    },
    beginUpgrade(...args: Parameters<ManagerStore["beginUpgrade"]>) {
      if (stopping) throw new ManagerError(409, "manager_stopping");
      return claims.run(args[0], () =>
        store.runAccountWork(args[0], async () => {
          if (await store.accountOperation(args[0], args[1])) return store.beginUpgrade(...args);
          const account = await store.getAccount(args[0]);
          if (!account) throw new ManagerError(404, "account_not_found");
          resolveUpgrade(account, undefined, args[2], args[3]);
          await provider.upgrade.requireRecoveryCapacity(account);
          return store.beginUpgrade(...args);
        }),
      );
    },
    recoverUpgrade(...args: Parameters<ManagerStore["recoverUpgrade"]>) {
      if (stopping) throw new ManagerError(409, "manager_stopping");
      return claims.run(args[0], () => store.recoverUpgrade(...args));
    },
    async bootstrap(accountId: string, input: z.infer<typeof BootstrapInputSchema>, expiresAt: Date) {
      if (stopping) throw new ManagerError(409, "manager_stopping");
      // Only one local writer holds the manager folder; serialize each account's private admin calls.
      return claims.run(accountId, () =>
        store.runAccountWork(accountId, async () => {
          const account = await store.getAccount(accountId);
          if (!account) throw new ManagerError(404, "account_not_found");
          const request = await store.beginBootstrap(accountId, input, expiresAt);
          const result = await provider.owner(account, request);
          await store.completeBootstrap(request.id, result.key.id);
          return result;
        }),
      );
    },
    async close() {
      stopping = true;
      await Promise.allSettled([reconciliation, claims.drain()]);
    },
  };
}
