import { TERMINAL_STATES } from "@pstdio/pocketcoder-contracts";
import type { ActiveCounts, WorkspaceAdmissionClaim } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { type DatabaseContext, lock, notifyChange, type QueryContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { appendTransition } from "./events";
import { workspaceFromRow } from "./mapping";

export function createAdmission(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces },
    schema,
  } = context;
  async function countActive(tx: QueryContext = db) {
    const rows = await tx
      .select({ principalId: workspaces.principalId, templateName: workspaces.templateName, n: count() })
      .from(workspaces)
      .where(inArray(workspaces.state, ["provisioning", "connected", "ready", "preserving", "terminating"]))
      .groupBy(workspaces.principalId, workspaces.templateName);
    const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
    for (const row of rows) {
      counts.global += row.n;
      counts.byPrincipal[row.principalId] = (counts.byPrincipal[row.principalId] ?? 0) + row.n;
      counts.byTemplate[row.templateName] = (counts.byTemplate[row.templateName] ?? 0) + row.n;
    }
    return counts;
  }
  return {
    async listQueuedHeads() {
      const heads = db
        .selectDistinctOn([workspaces.principalId])
        .from(workspaces)
        .where(eq(workspaces.state, "queued"))
        .orderBy(asc(workspaces.principalId), asc(workspaces.createdAt), asc(workspaces.id))
        .as("heads");
      return (await db.select().from(heads).orderBy(asc(heads.createdAt), asc(heads.id))).map(workspaceFromRow);
    },
    async listNonterminal() {
      return (
        await db
          .select()
          .from(workspaces)
          .where(notInArray(workspaces.state, [...TERMINAL_STATES]))
      ).map(workspaceFromRow);
    },
    countActive: () => countActive(),
    async countQueued() {
      const [row] = await db.select({ n: count() }).from(workspaces).where(eq(workspaces.state, "queued"));
      return requiredRow(row).n;
    },
    async claimWorkspaceAdmission(claim: WorkspaceAdmissionClaim) {
      const workspace = await db.transaction(async (tx) => {
        await lock(tx, `${schema}:workspace-admission`, 7351);
        const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, claim.workspaceId)).for("update");
        if (current?.state !== "queued" || current.purgeRequestedAt) return null;
        const counts = await countActive(tx);
        if (counts.global >= claim.limits.globalActiveWorkspaces) return null;
        if ((counts.byPrincipal[current.principalId] ?? 0) >= claim.limits.perPrincipalActiveWorkspaces) return null;
        const limit =
          claim.limits.perTemplateActiveWorkspaces[current.templateName] ?? claim.limits.globalActiveWorkspaces;
        if ((counts.byTemplate[current.templateName] ?? 0) >= limit) return null;
        const [row] = await tx
          .update(workspaces)
          .set({
            state: "provisioning",
            updatedAt: claim.at,
            changeSeq: sql`${workspaces.changeSeq}+1`,
            provisioningMode: "cold",
            registrationDigest: claim.registrationDigest,
            registrationExpiresAt: claim.registrationExpiresAt,
            launchAttempts: sql`${workspaces.launchAttempts}+1`,
          })
          .where(and(eq(workspaces.id, current.id), eq(workspaces.state, "queued")))
          .returning();
        if (!row) return null;
        const result = workspaceFromRow(row);
        await appendTransition(context, tx, result, "queued", result.reasonCode, claim.at);
        return result;
      });
      if (workspace) notifyChange(context, workspace.id);
      return workspace;
    },
  };
}
