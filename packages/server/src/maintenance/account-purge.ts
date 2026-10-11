import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { AccountPurgeReader } from "@pstdio/pocketcoder-db/off-node";
import type { MiddlewareHandler } from "hono";

export class AccountPurgeRequiredError extends Error {
  constructor() {
    super("Account purge requires private cleanup.");
  }
}

export function accountPurgeFence(read: AccountPurgeReader) {
  return async () => {
    let intent: Awaited<ReturnType<AccountPurgeReader>>;
    try {
      intent = await read();
    } catch {
      throw new ApiError("account.purge_pending", "Account purge authority is unavailable.");
    }
    if (intent) throw new ApiError("account.purged", "Account purge is permanent.");
  };
}

export function accountPurgeGate(assertAllowed?: () => Promise<void>): MiddlewareHandler {
  return async (_context, next) => {
    await assertAllowed?.();
    await next();
    // A response may reflect data changed while its handler was waiting.
    await assertAllowed?.();
  };
}

export async function requireNormalController(initialized: {
  accountPurge?: AccountPurgeReader;
  store: { close(): Promise<void> };
}) {
  try {
    if (await initialized.accountPurge?.()) throw new AccountPurgeRequiredError();
  } catch (error) {
    await initialized.store.close();
    throw error;
  }
}
