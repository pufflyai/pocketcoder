import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { EncryptedSecret } from "@pstdio/pocketcoder-runtime-contracts";
import { assertAuthorityScope } from "@pstdio/pocketcoder-runtime-core";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { lockKeyAuthority } from "../auth/authority";

export function createSecrets({ db, tables }: DatabaseContext) {
  const { secrets, secretVersions } = tables;
  const metadata = (row: typeof secrets.$inferSelect) => ({
    name: row.name,
    type: row.type,
    updatedAt: row.updatedAt,
    retiredAt: row.retiredAt,
  });
  async function authorize(tx: Transaction, actorKeyId: string) {
    const { authority } = await lockKeyAuthority(tx, tables, actorKeyId);
    assertAuthorityScope(authority, "secrets:write");
  }
  return {
    async writeSecret(actorKeyId: string, secret: EncryptedSecret) {
      return db.transaction(async (tx) => {
        await authorize(tx, actorKeyId);
        await lock(tx, secret.name, 4);
        await tx.insert(secretVersions).values({ ...secret, createdAt: sql`now()` });
        const [row] = await tx
          .insert(secrets)
          .values({
            name: secret.name,
            type: secret.type,
            versionId: secret.id,
            updatedAt: sql`now()`,
            retiredAt: null,
          })
          .onConflictDoUpdate({
            target: secrets.name,
            set: {
              type: secret.type,
              versionId: secret.id,
              updatedAt: sql`now()`,
              retiredAt: null,
            },
          })
          .returning();
        return metadata(requiredRow(row));
      });
    },
    async listSecrets(actorKeyId: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, actorKeyId);
        return (await tx.select().from(secrets).orderBy(asc(secrets.name))).map(metadata);
      });
    },
    async retireSecret(actorKeyId: string, name: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, actorKeyId);
        await lock(tx, name, 4);
        const [row] = await tx
          .update(secrets)
          .set({ retiredAt: sql`coalesce(${secrets.retiredAt}, now())` })
          .where(eq(secrets.name, name))
          .returning();
        if (!row) throw new ApiError("secret.not_found", "Unknown stored secret.");
        return metadata(row);
      });
    },
    async readSecret(name: string) {
      const [row] = await db
        .select({ version: secretVersions })
        .from(secrets)
        .innerJoin(secretVersions, eq(secrets.versionId, secretVersions.id))
        .where(and(eq(secrets.name, name), isNull(secrets.retiredAt)));
      return row?.version ?? null;
    },
    async readSecretVersion(id: string) {
      const [row] = await db.select().from(secretVersions).where(eq(secretVersions.id, id));
      return row ?? null;
    },
  };
}
