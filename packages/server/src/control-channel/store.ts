import type { Store } from "@pstdio/pocketcoder-runtime-core";

export function controlStore(store: Store, assertAllowed?: () => Promise<void>) {
  return {
    ...store,
    // A frame may have waited after its workspace read; admit the write itself.
    async commitConversationTurn(...args: Parameters<Store["commitConversationTurn"]>) {
      await assertAllowed?.();
      return store.commitConversationTurn(...args);
    },
    async appendWorkspaceMessage(...args: Parameters<Store["appendWorkspaceMessage"]>) {
      await assertAllowed?.();
      return store.appendWorkspaceMessage(...args);
    },
  };
}
