import type { WarmPoolClaim, WarmPoolRuntimePatch, WarmPoolRuntimeRow } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { appendTransition } from "../workspaces/events";
import { workspaceFromRow } from "../workspaces/mapping";

export function createWarmPools(context: DatabaseContext) {
  const {
    db,
    tables: { warmPoolRuntimes: runtimes, workspaces },
  } = context;
  async function getWarmPoolRuntime(id: string) {
    const [row] = await db.select().from(runtimes).where(eq(runtimes.id, id));
    return row ?? null;
  }
  return {
    getWarmPoolRuntime,
    async insertWarmPoolRuntime(input: WarmPoolRuntimeRow) {
      const [row] = await db.insert(runtimes).values(input).onConflictDoNothing({ target: runtimes.id }).returning();
      return row ?? requiredRow(await getWarmPoolRuntime(input.id));
    },
    async listWarmPoolRuntimes() {
      return db.select().from(runtimes).orderBy(asc(runtimes.createdAt));
    },
    async updateWarmPoolRuntime(id: string, patch: WarmPoolRuntimePatch, at: Date) {
      await db
        .update(runtimes)
        .set({ ...patch, updatedAt: at })
        .where(eq(runtimes.id, id));
    },
    async claimWarmPoolRuntime(claim: WarmPoolClaim) {
      const result = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, claim.workspaceId)).for("update");
        if (current?.state !== "queued" || current.purgeRequestedAt) return null;
        const [runtime] = await tx
          .select()
          .from(runtimes)
          .where(
            and(
              eq(runtimes.templateDigest, claim.templateDigest),
              eq(runtimes.driverKind, claim.driverKind),
              eq(runtimes.eligibilityFingerprint, claim.eligibilityFingerprint),
              eq(runtimes.state, "ready"),
              isNotNull(runtimes.providerRef),
            ),
          )
          .orderBy(asc(runtimes.readyAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!runtime) return null;
        const [leased] = await tx
          .update(runtimes)
          .set({ state: "leasing", workspaceId: current.id, leasedAt: claim.at, updatedAt: claim.at })
          .where(and(eq(runtimes.id, runtime.id), eq(runtimes.state, "ready")))
          .returning();
        if (!leased) return null;
        const [row] = await tx
          .update(workspaces)
          .set({
            state: "provisioning",
            provisioningMode: "warm",
            providerKind: runtime.driverKind,
            providerRef: runtime.providerRef,
            registrationDigest: claim.registrationDigest,
            registrationExpiresAt: claim.registrationExpiresAt,
            launchAttempts: sql`${workspaces.launchAttempts}+1`,
            updatedAt: claim.at,
            changeSeq: sql`${workspaces.changeSeq}+1`,
          })
          .where(and(eq(workspaces.id, current.id), eq(workspaces.state, "queued")))
          .returning();
        if (!row) throw new Error("warm_pool.claim_workspace_race");
        const workspace = workspaceFromRow(row);
        await appendTransition(context, tx, workspace, "queued", null, claim.at);
        return { runtime: leased, workspace };
      });
      if (result) notifyChange(context, claim.workspaceId);
      return result;
    },
  };
}
