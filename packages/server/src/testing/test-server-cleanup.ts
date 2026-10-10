import { registerTestCleanup } from "@pstdio/pocketcoder-db/testing";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { BuiltServer } from "../app";

export function registerServerTestCleanup(store: Store, server: BuiltServer) {
  registerTestCleanup(store, async () => {
    await server.screenshots?.close();
    await server.scheduler.drain();
    await server.persistence.drain();
    await server.scheduler.drain();
  });
}
