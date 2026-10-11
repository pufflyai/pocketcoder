import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./middleware";

export function journalGate(store: Store): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    if (context.req.method === "GET" || context.req.method === "HEAD") await store.acknowledgeJournal?.();
    await next();
    // Status and metadata queries can observe a mutation that happened after their first barrier.
    if (context.res.status < 400) await store.acknowledgeJournal?.();
  };
}
