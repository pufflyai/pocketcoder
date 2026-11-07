import type { PreviewGrantStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";

export function createPreviewGrants({ db, tables: { previewGrants: grants } }: DatabaseContext): PreviewGrantStore {
  return {
    async create(grant) {
      const [row] = await db.insert(grants).values(grant).onConflictDoNothing().returning();
      return row ?? null;
    },
    async get(id) {
      const [row] = await db.select().from(grants).where(eq(grants.id, id));
      return row ?? null;
    },
    async renew(id, revision, expiresAt, now) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(grants).where(eq(grants.id, id)).for("update");
        // A request can wait behind another writer. Its earlier clock reading
        // must not revive a lease that expired while it waited for this lock.
        const at = new Date(Math.max(now.getTime(), Date.now()));
        if (
          !row ||
          row.accessRevision !== revision ||
          row.revokedAt ||
          row.expiresAt <= at ||
          row.ceilingAt <= at ||
          expiresAt > row.ceilingAt ||
          expiresAt < row.expiresAt
        )
          return null;
        const [updated] = await tx.update(grants).set({ expiresAt }).where(eq(grants.id, id)).returning();
        return updated ?? null;
      });
    },
    async revoke(id, now) {
      await db
        .update(grants)
        .set({ revokedAt: now })
        .where(and(eq(grants.id, id), isNull(grants.revokedAt)));
      const [row] = await db.select().from(grants).where(eq(grants.id, id));
      return row ?? null;
    },
  };
}
