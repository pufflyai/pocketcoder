import { usageRepository } from "../usage/repository";
import { accountRepository } from "./account-repository";
import { backupRepository } from "./backup-repository";
import { bootstrapRepository } from "./bootstrap-repository";
import { managerContext } from "./context";
import { lifecycleRepository } from "./lifecycle-repository";
export const ManagerStore = {
  async create(dataDir?: string) {
    const context = await managerContext(dataDir);
    return {
      ...accountRepository(context),
      ...bootstrapRepository(context),
      ...usageRepository(context),
      ...lifecycleRepository(context),
      ...backupRepository(context),
      close: () => context.close(),
    };
  },
};
export type ManagerStore = Awaited<ReturnType<typeof ManagerStore.create>>;
export type Account = NonNullable<Awaited<ReturnType<ManagerStore["getAccount"]>>>;
