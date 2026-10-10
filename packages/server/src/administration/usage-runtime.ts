import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hono } from "hono";

export function registerUsageRuntimeRoute(app: Hono, store: Store) {
  app.get("/v1/usage/warm-claims", async (context) => {
    const runtimes = await store.listWarmPoolRuntimes();
    return context.json({
      claimed_warm_runtime_ids: runtimes.filter((runtime) => runtime.workspaceId).map((runtime) => runtime.id),
    });
  });
}
