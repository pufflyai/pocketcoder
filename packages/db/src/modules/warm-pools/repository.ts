import { randomUUID } from "node:crypto";
import type { WarmPoolClaim, WarmPoolRuntimePatch, WarmPoolRuntimeRow } from "@pstdio/pocketcoder-runtime-contracts";
import { buildEventEnvelope } from "@pstdio/pocketcoder-runtime-core";
import { asc, eq } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { workspaceFromRow } from "../workspaces/mapping";
import { createWarmClaimQuery } from "./claim-query";
import { createLockedWorkspaceQuery } from "./locked-workspace-query";

export function createWarmPools(context: DatabaseContext) {
  const {
    db,
    tables: { warmPoolRuntimes: runtimes },
  } = context;
  let lockedWorkspaceQuery: ReturnType<typeof createLockedWorkspaceQuery> | undefined;
  let claimQuery: ReturnType<typeof createWarmClaimQuery> | undefined;
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
        lockedWorkspaceQuery ??= createLockedWorkspaceQuery(context);
        const [current] = await lockedWorkspaceQuery(tx, claim.workspaceId);
        if (current?.state !== "queued" || current.purgeRequestedAt) return null;
        const payload = buildEventEnvelope(
          { ...current, state: "provisioning", provisioningMode: "warm", changeSeq: current.changeSeq + 1 },
          claim.at,
        );
        // Only the statement shape is shared; rows and parameters belong to this transaction.
        claimQuery ??= createWarmClaimQuery(context);
        const [result] = await claimQuery(tx, {
          ...claim,
          historyId: randomUUID(),
          eventId: payload.id,
          eventType: payload.type,
          payload,
        });
        if (!result) return null;
        if (!result.workspace) throw new Error("warm_pool.claim_workspace_race");
        const workspace = workspaceFromRow(result.workspace);
        return { runtime: result.runtime, workspace };
      });
      if (result) notifyChange(context, claim.workspaceId);
      return result;
    },
  };
}
