import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { Hono } from "hono";
import { z } from "zod";
import type { PurgeCleanup } from "../maintenance/purge-cleanup";

export function registerPurgeAdmin(app: Hono, cleanup: PurgeCleanup) {
  app.get("/v1/account/purge", async (context) => context.json(await cleanup.status()));
  app.post("/v1/account/purge", async (context) => {
    const input = z.strictObject({ operation_id: z.uuid() }).parse(await context.req.json());
    try {
      return context.json(await cleanup.perform(input.operation_id));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("account.purge_pending", "Account cleanup remains pending.");
    }
  });
}
