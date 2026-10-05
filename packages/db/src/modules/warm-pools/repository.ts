import { randomUUID } from "node:crypto";
import type { WarmPoolClaim, WarmPoolRuntimePatch, WarmPoolRuntimeRow } from "@pstdio/pocketcoder-runtime-contracts";
import { buildEventEnvelope } from "@pstdio/pocketcoder-runtime-core";
import { and, asc, eq, getColumns, isNotNull, sql } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { workspaceFromRow } from "../workspaces/mapping";

export function createWarmPools(context: DatabaseContext) {
  const {
    db,
    tables: { warmPoolRuntimes: runtimes, workspaces, workspaceStateHistory: history, eventOutbox: outbox },
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
        const [current] = await tx
          .select({
            id: workspaces.id,
            state: workspaces.state,
            purgeRequestedAt: workspaces.purgeRequestedAt,
            externalId: workspaces.externalId,
            reasonCode: workspaces.reasonCode,
            agentState: workspaces.agentState,
            provisioningMode: workspaces.provisioningMode,
            changeSeq: workspaces.changeSeq,
            failureLogTail: workspaces.failureLogTail,
            failureLogTailTruncated: workspaces.failureLogTailTruncated,
            failureLastLogSeq: workspaces.failureLastLogSeq,
            templateName: workspaces.templateName,
            templateVersion: workspaces.templateVersion,
            templateDigest: workspaces.templateDigest,
            originWorkspaceId: workspaces.originWorkspaceId,
            restoredFromCheckpointId: workspaces.restoredFromCheckpointId,
            latestCheckpointId: workspaces.latestCheckpointId,
            outputs: workspaces.outputs,
          })
          .from(workspaces)
          .where(eq(workspaces.id, claim.workspaceId))
          .for("update");
        if (current?.state !== "queued" || current.purgeRequestedAt) return null;
        const ready = tx
          .select({ id: runtimes.id })
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
        const leased = tx.$with("leased_runtime").as(
          tx
            .update(runtimes)
            .set({ state: "leasing", workspaceId: current.id, leasedAt: claim.at, updatedAt: claim.at })
            .where(and(eq(runtimes.id, ready), eq(runtimes.state, "ready")))
            .returning(),
        );
        const admitted = tx.$with("admitted_workspace").as(
          tx
            .update(workspaces)
            .set({
              state: "provisioning",
              provisioningMode: "warm",
              providerKind: sql`${leased.driverKind}`,
              providerRef: sql`${leased.providerRef}`,
              registrationDigest: claim.registrationDigest,
              registrationExpiresAt: claim.registrationExpiresAt,
              launchAttempts: sql`${workspaces.launchAttempts}+1`,
              updatedAt: claim.at,
              changeSeq: sql`${workspaces.changeSeq}+1`,
            })
            .from(leased)
            .where(and(eq(workspaces.id, current.id), eq(workspaces.state, "queued")))
            .returning(getColumns(workspaces)),
        );
        const payload = buildEventEnvelope(
          { ...current, state: "provisioning", provisioningMode: "warm", changeSeq: current.changeSeq + 1 },
          claim.at,
        );
        const recorded = tx.$with("recorded_transition").as(
          tx
            .insert(history)
            .select(
              tx
                .select({
                  id: sql<string>`${randomUUID()}`.as("id"),
                  workspaceId: admitted.id,
                  fromState: sql<"queued">`'queued'`.as("from_state"),
                  toState: admitted.state,
                  reasonCode: sql<null>`null`.as("reason_code"),
                  occurredAt: sql<Date>`${sql.param(claim.at, history.occurredAt)}`.as("occurred_at"),
                })
                .from(admitted),
            )
            .returning({ id: history.id }),
        );
        const emitted = tx.$with("emitted_transition").as(
          tx
            .insert(outbox)
            .select(
              tx
                .select({
                  id: sql<string>`${payload.id}`.as("id"),
                  workspaceId: admitted.id,
                  eventType: sql<string>`${payload.type}`.as("event_type"),
                  payload: sql<typeof payload>`${sql.param(payload, outbox.payload)}`.as("payload"),
                  occurredAt: sql<Date>`${sql.param(claim.at, outbox.occurredAt)}`.as("occurred_at"),
                  nextAttemptAt: sql<Date>`${sql.param(claim.at, outbox.nextAttemptAt)}`.as("next_attempt_at"),
                })
                .from(admitted),
            )
            .returning({ id: outbox.id }),
        );
        const [result] = await tx
          .with(leased, admitted, recorded, emitted)
          .select({ runtime: getColumns(leased), workspace: getColumns(admitted) })
          .from(leased)
          .leftJoin(admitted, eq(admitted.id, leased.workspaceId));
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
