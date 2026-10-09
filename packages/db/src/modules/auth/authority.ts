import { ApiError } from "@pstdio/pocketcoder-contracts";
import { keyAuthority } from "@pstdio/pocketcoder-runtime-core";
import { asc, eq, inArray } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function lockKeyAuthority(
  tx: Transaction,
  { principals, machineKeys }: Pick<DatabaseContext["tables"], "principals" | "machineKeys">,
  keyId: string,
  targetId?: string,
  additionalIds: string[] = [],
) {
  const [identity] = await tx
    .select({ principalId: machineKeys.principalId })
    .from(machineKeys)
    .where(eq(machineKeys.id, keyId));
  if (!identity) throw new ApiError("auth.invalid_key", "Unknown calling key.");
  const ids = [identity.principalId, ...additionalIds];
  if (targetId) ids.push(targetId);
  const locked = await tx
    .select()
    .from(principals)
    .where(inArray(principals.id, ids))
    .orderBy(asc(principals.id))
    .for("update");
  const caller = locked.find((row) => row.id === identity.principalId);
  const [key] = await tx.select().from(machineKeys).where(eq(machineKeys.id, keyId)).for("update");
  if (!caller || !key) throw new ApiError("auth.invalid_key", "Unknown calling key.");
  const authority = keyAuthority(caller, key, new Date());
  return { authority, key, target: locked.find((row) => row.id === targetId), locked };
}
