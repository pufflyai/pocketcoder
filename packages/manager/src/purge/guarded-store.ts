import type { accountRepository } from "../database/account-repository";
import type { backupRepository } from "../database/backup-repository";
import type { bootstrapRepository } from "../database/bootstrap-repository";
import type { lifecycleRepository } from "../database/lifecycle-repository";
import type { usageRepository } from "../usage/repository";
import { admittedWork } from "./admitted-work";
import type { PurgeAuthority } from "./authority";
import { createRequestDigest, type PurgeIntent } from "./intent";

type Repositories = ReturnType<typeof accountRepository> &
  ReturnType<typeof backupRepository> &
  ReturnType<typeof bootstrapRepository> &
  ReturnType<typeof lifecycleRepository> &
  ReturnType<typeof usageRepository>;

export function guardedStore(store: Repositories, authority: PurgeAuthority) {
  const activity = admittedWork();
  const accountKey = (id: string) => `account:${id}`;
  const requestKey = (id: string) => `create:${createRequestDigest(id)}`;
  const blocked = (row: { id: string; requestId: string }) =>
    Boolean(authority.account(row.id) || authority.request(row.requestId));
  async function allowed(id: string) {
    authority.assertAccount(id);
    const row = await store.getAccount(id);
    await authority.refresh();
    authority.assertAccount(id);
    if (row) authority.assertRequest(row.requestId);
    return row;
  }
  function account<T>(id: string, run: () => Promise<T>) {
    return activity.run([accountKey(id)], true, async (resolve) => {
      const prior = await allowed(id);
      resolve(prior ? [requestKey(prior.requestId)] : []);
      const result = await run();
      await allowed(id);
      if (prior) authority.assertRequest(prior.requestId);
      return result;
    });
  }
  function operation<T>(id: string, run: () => Promise<T>) {
    return activity.run([], true, async (resolve) => {
      const row = await store.getOperation(id);
      resolve(row ? [accountKey(row.accountId)] : []);
      if (!row) return run();
      return account(row.accountId, run);
    });
  }
  return {
    ...store,
    runAccountWork: account,
    async settlePurge(intent: PurgeIntent) {
      await activity.settle([accountKey(intent.accountId), `create:${intent.createRequestDigest}`]);
    },
    createAccount(...args: Parameters<Repositories["createAccount"]>) {
      return activity.run([requestKey(args[0])], false, async () => {
        await authority.refresh();
        authority.assertRequest(args[0]);
        const result = await store.createAccount(...args);
        if (result.created)
          await authority.history.admit({
            accountId: result.account.id,
            createRequestDigest: createRequestDigest(args[0]),
            originalCreateOperationId: result.operation.id,
          });
        await authority.refresh();
        authority.assertRequest(args[0]);
        authority.assertAccount(result.account.id);
        return result;
      });
    },
    getAccount: (id: string) => account(id, () => store.getAccount(id)),
    getOperation: (id: string) => operation(id, () => store.getOperation(id)),
    async listAccounts() {
      await authority.refresh();
      const rows = await store.listAccounts();
      await authority.refresh();
      return rows.filter((row) => !blocked(row));
    },
    async pendingOperations() {
      await authority.refresh();
      const rows = await store.pendingOperations();
      const accounts = new Map((await store.listAccounts()).map((row) => [row.id, row]));
      await authority.refresh();
      return rows.filter((row) => {
        const account = accounts.get(row.accountId);
        return account && !blocked(account);
      });
    },
    finishAccount: (...args: Parameters<Repositories["finishAccount"]>) =>
      account(args[0], () => store.finishAccount(...args)),
    beginBootstrap: (...args: Parameters<Repositories["beginBootstrap"]>) =>
      account(args[0], () => store.beginBootstrap(...args)),
    completeBootstrap(...args: Parameters<Repositories["completeBootstrap"]>) {
      return activity.run([], true, async (resolve) => {
        const id = await store.bootstrapAccountId(args[0]);
        resolve([accountKey(id)]);
        return account(id, () => store.completeBootstrap(...args));
      });
    },
    beginLifecycle: (...args: Parameters<Repositories["beginLifecycle"]>) =>
      account(args[0], () => store.beginLifecycle(...args)),
    beginBackupOperation: (...args: Parameters<Repositories["beginBackupOperation"]>) =>
      account(args[0], () => store.beginBackupOperation(...args)),
    listBackups: (id: string) => account(id, () => store.listBackups(id)),
    getUsage: (...args: Parameters<Repositories["getUsage"]>) => account(args[0], () => store.getUsage(...args)),
    recordUsageSample: (...args: Parameters<Repositories["recordUsageSample"]>) =>
      account(args[0].accountId, () => store.recordUsageSample(...args)),
    startOperation: (id: string) => operation(id, () => store.startOperation(id)),
    setOperationPhase: (...args: Parameters<Repositories["setOperationPhase"]>) =>
      operation(args[0], () => store.setOperationPhase(...args)),
    saveBackup: (...args: Parameters<Repositories["saveBackup"]>) =>
      operation(args[0], () => store.saveBackup(...args)),
    saveComputeProof: (...args: Parameters<Repositories["saveComputeProof"]>) =>
      operation(args[0], () => store.saveComputeProof(...args)),
    markRestorePrepared: (...args: Parameters<Repositories["markRestorePrepared"]>) =>
      operation(args[0], () => store.markRestorePrepared(...args)),
    recordError: (id: string) => operation(id, () => store.recordError(id)),
    sourceComputeProof: (id: string) => account(id, () => store.sourceComputeProof(id)),
    getBackup(id: string) {
      return activity.run([], true, async (resolve) => {
        const backup = await store.getBackup(id);
        resolve(backup ? [accountKey(backup.accountId)] : []);
        return backup ? account(backup.accountId, () => store.getBackup(id)) : null;
      });
    },
  };
}
