import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { MachineKeyRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { revokeKeyIds, unrevokedKeyIds } from "./key-ids";

export function createOwnerBootstrap({ db, journal, tables }: DatabaseContext) {
  const { principals, machineKeys } = tables;
  return async (input: Omit<MachineKeyRow, "principalId"> & { issuanceRequestId: string }, replace: boolean) => {
    let reenabled: { principalId: string; at: Date } | undefined;
    const result = await db.transaction(async (tx) => {
      if (!input.expiresAt || input.expiresAt <= new Date())
        throw new ApiError("validation.invalid", "Owner credentials require a future expiry.");
      await tx
        .insert(principals)
        .values({
          id: randomUUID(),
          name: "owner",
          scopes: ["admin"],
          templateNames: ["*"],
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: principals.name });
      const principal = requiredRow(
        (await tx.select().from(principals).where(eq(principals.name, "owner")).for("update"))[0],
      );
      const [existing] = await tx
        .select()
        .from(machineKeys)
        .where(
          and(eq(machineKeys.principalId, principal.id), eq(machineKeys.issuanceRequestId, input.issuanceRequestId)),
        );
      if (existing)
        return {
          key: existing,
          principal,
          created: false,
          conflict: existing.issuanceRequestDigest !== input.issuanceRequestDigest,
        };
      const at = new Date();
      if (replace) {
        const keyIds = await unrevokedKeyIds(tx, tables, principal.id);
        journal?.append({ kind: "keys_revoked", principalId: principal.id, keyIds, at: at.toISOString() });
        await revokeKeyIds(tx, tables, keyIds, at);
      }
      if (principal.disabledAt) reenabled = { principalId: principal.id, at };
      const owner = requiredRow(
        (
          await tx
            .update(principals)
            .set({
              scopes: ["admin"],
              templateNames: ["*"],
              disabledAt: null,
            })
            .where(eq(principals.id, principal.id))
            .returning()
        )[0],
      );
      const key = requiredRow(
        (
          await tx
            .insert(machineKeys)
            .values({ ...input, principalId: owner.id })
            .returning()
        )[0],
      );
      return { key, principal: owner, created: true, conflict: false };
    });
    // Granting records follow the commit: if one is lost, a restore keeps the owner disabled.
    if (reenabled)
      journal?.append({
        kind: "principal_enabled",
        principalId: reenabled.principalId,
        at: reenabled.at.toISOString(),
      });
    return result;
  };
}
