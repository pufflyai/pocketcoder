import { createPurgeAuthority, type PurgeAuthority, type PurgeAuthorityConfig } from "../purge/authority";
import { guardedStore } from "../purge/guarded-store";
import type { PurgeIntent } from "../purge/intent";
import { purgeReconciliation } from "../purge/reconciliation";
import { usageRepository } from "../usage/repository";
import { accountRepository } from "./account-repository";
import { backupRepository } from "./backup-repository";
import { bootstrapRepository } from "./bootstrap-repository";
import { type ManagerContext, managerContext } from "./context";
import { lifecycleRepository } from "./lifecycle-repository";
export function managerRepositories(context: ManagerContext) {
  return {
    ...accountRepository(context),
    ...bootstrapRepository(context),
    ...usageRepository(context),
    ...lifecycleRepository(context),
    ...backupRepository(context),
    runAccountWork: <T>(_id: string, run: () => Promise<T>) => run(),
    async settlePurge(_intent: PurgeIntent) {
      throw new Error("Purge authority is not configured.");
    },
  };
}
export const ManagerStore = {
  async create(dataDir?: string, purgeConfig?: PurgeAuthorityConfig) {
    const context = await managerContext(dataDir);
    try {
      if (purgeConfig && !dataDir) throw new Error("Purge authority requires a durable manager folder.");
      const purge = purgeConfig && dataDir ? await createPurgeAuthority(dataDir, purgeConfig) : undefined;
      const authority: { purge?: PurgeAuthority } = purge ? { purge } : {};
      const repositories = managerRepositories(context);
      const guarded = purge ? guardedStore(repositories, purge) : repositories;
      const runtime: { purgeRuntime?: ReturnType<typeof purgeReconciliation> } = purge
        ? { purgeRuntime: purgeReconciliation(context, purge, guarded.settlePurge) }
        : {};
      return {
        ...guarded,
        ...runtime,
        ...authority,
        async close() {
          try {
            await context.close();
          } finally {
            purge?.close();
          }
        },
      };
    } catch (error) {
      await context.close();
      throw error;
    }
  },
};
export type ManagerStore = Awaited<ReturnType<typeof ManagerStore.create>>;
export type Account = NonNullable<Awaited<ReturnType<ManagerStore["getAccount"]>>>;
