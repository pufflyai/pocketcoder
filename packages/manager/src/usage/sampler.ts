import type { ManagerStore } from "../database/store";
import { observeUsage } from "./observation";

export function usageSampler(store: ManagerStore) {
  let running: Promise<void> | undefined;
  let stopping = false;
  return {
    sample(at?: Date) {
      if (stopping) return Promise.resolve();
      if (running) return running;
      running = (async () => {
        await store.pruneUsageSamples(at ?? new Date());
        for (const account of await store.listAccounts()) {
          if (stopping) break;
          const now = at ?? new Date();
          if (account.state !== "ready" || (await store.hasUsageSample(account.id, now))) continue;
          const observation = await observeUsage(account);
          await store.recordUsageSample({ accountId: account.id, sampledAt: now, ...observation });
        }
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    async close() {
      stopping = true;
      await running;
    },
  };
}
