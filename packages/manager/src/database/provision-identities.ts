import { and, eq } from "drizzle-orm";
import { createRequestDigest } from "../purge/intent";
import type { ManagerContext } from "./context";

export function provisionIdentities({ db, tables: { accounts, operations }, validate }: ManagerContext) {
  return async (digest: string) => {
    validate();
    const rows = await db
      .select({
        accountId: accounts.id,
        requestId: accounts.requestId,
        originalCreateOperationId: operations.id,
      })
      .from(accounts)
      .leftJoin(operations, and(eq(operations.accountId, accounts.id), eq(operations.kind, "provision")));
    return rows
      .filter((row) => createRequestDigest(row.requestId) === digest)
      .map((row) => {
        if (!row.originalCreateOperationId) throw new Error("Purge original provision operation is missing.");
        return {
          accountId: row.accountId,
          createRequestDigest: digest,
          originalCreateOperationId: row.originalCreateOperationId,
        };
      });
  };
}
