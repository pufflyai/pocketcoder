import { AccountPurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
import { createRequestDigest } from "../purge/intent";
import { namespaceForAccount } from "../purge/namespace-binding";
import type { ManagerContext } from "./context";

export function purgeTargets({ db, tables: { accounts }, validate }: ManagerContext) {
  return async (input: unknown) => {
    validate();
    const intent = AccountPurgeIntentSchema.parse(input);
    const rows = await db
      .select({ id: accounts.id, namespace: accounts.namespace, requestId: accounts.requestId })
      .from(accounts);
    const original = rows.find((row) => row.id === intent.accountId);
    if (original && createRequestDigest(original.requestId) !== intent.createRequestDigest)
      throw new Error("Purge account create identity differs.");
    return rows
      .filter((row) => createRequestDigest(row.requestId) === intent.createRequestDigest)
      .map((row) => {
        if (row.namespace !== namespaceForAccount(row.id)) throw new Error("Purge namespace identity differs.");
        return { id: row.id, namespace: row.namespace };
      });
  };
}
