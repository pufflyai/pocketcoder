import { digestOf } from "@pstdio/pocketcoder-contracts";
import type { ManagedCredentialBinding } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { authorityContext, conflict, unavailable } from "./authority-context";

type Registration = Omit<ManagedCredentialBinding, "secretVersionId"> & { secretVersionId?: string };
export function credentialBindings(context: DatabaseContext) {
  const { db, tables } = context;
  const auth = authorityContext(context);
  return async (keyId: string, input: Registration) =>
    db.transaction(async (tx) => {
      const actor = await auth.caller(tx, keyId, "admin", input.principalId);
      if (
        !actor.target ||
        actor.target.disabledAt ||
        input.authorityExpiresAt <= new Date() ||
        !input.slots.length ||
        new Set(input.slots).size !== input.slots.length
      )
        throw unavailable();
      await lock(tx, input.secretName, 4);
      await lock(tx, input.bindingId, 31);
      const [known] = await tx
        .select()
        .from(tables.managedCredentials)
        .where(eq(tables.managedCredentials.bindingId, input.bindingId));
      const facts = {
        ...input,
        slots: [...input.slots].sort(),
        authorityExpiresAt: input.authorityExpiresAt.toISOString(),
      };
      if (known) {
        if (
          digestOf(known.binding) !==
          digestOf({ ...facts, secretVersionId: input.secretVersionId ?? known.binding.secretVersionId })
        )
          throw conflict();
        return;
      }
      const [current] = await tx
        .select()
        .from(tables.secrets)
        .where(
          and(
            eq(tables.secrets.name, input.secretName),
            eq(tables.secrets.type, "runtime-issuer"),
            isNull(tables.secrets.retiredAt),
          ),
        );
      if (!current) throw unavailable();
      const secretVersionId = input.secretVersionId ?? current.versionId;
      const [issuer] = await tx
        .select()
        .from(tables.secretVersions)
        .where(
          and(
            eq(tables.secretVersions.id, secretVersionId),
            eq(tables.secretVersions.name, input.secretName),
            eq(tables.secretVersions.type, "runtime-issuer"),
          ),
        );
      if (!issuer) throw unavailable();
      await tx
        .insert(tables.managedCredentials)
        .values({ bindingId: input.bindingId, binding: { ...facts, secretVersionId } });
    });
}
