import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";

export function createKeyExpiry({ db, tables: { principals, machineKeys } }: DatabaseContext) {
  return {
    // Keys that still authenticate at `at`, soonest expiry first.
    async listActiveMachineKeys(at: Date, expiringBefore?: Date) {
      return db
        .select({ key: machineKeys, principal: principals })
        .from(machineKeys)
        .innerJoin(principals, eq(principals.id, machineKeys.principalId))
        .where(
          and(
            isNull(principals.disabledAt),
            isNull(machineKeys.revokedAt),
            gt(machineKeys.expiresAt, at),
            expiringBefore ? lte(machineKeys.expiresAt, expiringBefore) : undefined,
          ),
        )
        .orderBy(asc(machineKeys.expiresAt), asc(machineKeys.id));
    },
  };
}
