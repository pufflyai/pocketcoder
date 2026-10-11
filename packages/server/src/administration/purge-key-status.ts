import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { AccountPurgeReader } from "@pstdio/pocketcoder-db/off-node";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Hono } from "hono";
import { z } from "zod";

export function registerPurgeKeyStatus(app: Hono, store: Store, read: AccountPurgeReader) {
  app.get("/v1/account/purge/keys/:id", async (context) => {
    const id = z.uuid().parse(context.req.param("id"));
    const result = await store.getMachineKeyWithPrincipal(id);
    if (!result) throw new ApiError("key.not_found", "Key not found.");
    const key = result.key;
    const intent = await read();
    return context.json({
      account_id: read.accountId,
      operation_id: intent?.operationId ?? null,
      key: {
        id: key.id,
        expires_at: key.expiresAt?.toISOString() ?? null,
        revoked_at: key.revokedAt?.toISOString() ?? null,
      },
    });
  });
}
