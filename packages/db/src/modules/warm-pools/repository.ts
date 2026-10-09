import { randomUUID } from "node:crypto";
import type { WarmPoolClaim, WarmPoolRuntimePatch, WarmPoolRuntimeRow } from "@pstdio/pocketcoder-runtime-contracts";
import { buildEventEnvelope } from "@pstdio/pocketcoder-runtime-core";
import { asc, eq } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { workspaceFromRow } from "../workspaces/mapping";
import { createWarmClaimQuery } from "./claim-query";

export function createWarmPools(context: DatabaseContext) {
  const {
    db,
    tables: { warmPoolRuntimes: runtimes },
  } = context;
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
      const current = claim.workspace;
      const payload = buildEventEnvelope(
        { ...current, state: "provisioning", provisioningMode: "warm", changeSeq: current.changeSeq + 1 },
        claim.at,
      );
      claimQuery ??= createWarmClaimQuery(context);
      // The statement commits the lease, workspace, history and event atomically.
      const [result] = await claimQuery({
        ...claim,
        workspaceId: current.id,
        expectedChangeSeq: current.changeSeq,
        expectedOutputs: current.outputs,
        historyId: randomUUID(),
        eventId: payload.id,
        eventType: payload.type,
        payload,
      });
      if (!result) return null;
      if (result.stale) return { kind: "stale" } as const;
      if (!result.runtime) return null;
      if (!result.workspace) throw new Error("warm_pool.claim_workspace_race");
      notifyChange(context, current.id);
      return { runtime: result.runtime, workspace: workspaceFromRow(result.workspace) };
    },
  };
}
