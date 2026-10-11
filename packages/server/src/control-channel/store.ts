import type { Store } from "@pstdio/pocketcoder-runtime-core";

export function controlStore(store: Store, assertAllowed?: () => Promise<void>) {
  return {
    ...store,
    async appendConversationMessage(...args: Parameters<Store["appendConversationMessage"]>) {
      // A frame may have waited after its workspace read; admit the write itself.
      await assertAllowed?.();
      return store.appendConversationMessage(...args);
    },
  };
}
