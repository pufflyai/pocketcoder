import { randomUUID } from "node:crypto";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { MachineKeyRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function createOwnerBootstrap({ db, tables: { principals, machineKeys } }: DatabaseContext) {
  return async (input: Omit<MachineKeyRow, "principalId"> & { issuanceRequestId: string }, replace: boolean) =>
    db.transaction(async (tx) => {
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
      if (replace)
        await tx
          .update(machineKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(machineKeys.principalId, principal.id), isNull(machineKeys.revokedAt)));
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
}
