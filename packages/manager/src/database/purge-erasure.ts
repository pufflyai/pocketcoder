import { type AccountPurgeIntent, AccountPurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
import { eq, inArray } from "drizzle-orm";
import { createRequestDigest } from "../purge/intent";
import type { ManagerContext } from "./context";

export function purgeErasure({ db, tables: { accounts }, validate }: ManagerContext) {
  return async (input: AccountPurgeIntent) => {
    const intent = AccountPurgeIntentSchema.parse(input);
    validate();
    await db.transaction(async (tx) => {
      const rows = await tx.select({ id: accounts.id, requestId: accounts.requestId }).from(accounts).for("update");
      const original = rows.find((row) => row.id === intent.accountId);
      if (original && createRequestDigest(original.requestId) !== intent.createRequestDigest)
        throw new Error("Purged account create identity differs.");
      const owned = rows.filter((row) => createRequestDigest(row.requestId) === intent.createRequestDigest);
      if (owned.length)
        await tx.delete(accounts).where(
          inArray(
            accounts.id,
            owned.map((row) => row.id),
          ),
        );
      const [remaining] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, intent.accountId));
      if (remaining) throw new Error("Purged account content remains.");
    });
    validate();
  };
}
