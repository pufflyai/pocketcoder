import { type AdmissionReason, TERMINAL_STATES } from "@pstdio/pocketcoder-contracts";
import type { ActiveCounts, WorkspaceAdmissionClaim } from "@pstdio/pocketcoder-runtime-contracts";
import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { type DatabaseContext, lock, notifyChange, type QueryContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { capacityAdmission, reserveCapacityAdmission } from "../budgets/capacity-admission";
import { appendTransition } from "./events";
import { workspaceFromRow } from "./mapping";

export function createAdmission(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces },
    schema,
  } = context;
  function activeQuery(query: QueryContext) {
    return query
      .select({ principalId: workspaces.principalId, templateName: workspaces.templateName, n: count() })
      .from(workspaces)
      .where(inArray(workspaces.state, ["provisioning", "connected", "ready", "preserving", "terminating"]))
      .groupBy(workspaces.principalId, workspaces.templateName);
  }
  function prepareActive() {
    return activeQuery(db).prepare("active_workspaces");
  }
  let active: ReturnType<typeof prepareActive> | undefined;
  async function countActive(tx?: QueryContext) {
    async function readCounts() {
      if (tx) return activeQuery(tx);
      active ??= prepareActive();
      return active.execute();
    }
    const rows = await readCounts();
    const counts: ActiveCounts = { global: 0, byPrincipal: {}, byTemplate: {} };
    for (const row of rows) {
      counts.global += row.n;
      counts.byPrincipal[row.principalId] = (counts.byPrincipal[row.principalId] ?? 0) + row.n;
      counts.byTemplate[row.templateName] = (counts.byTemplate[row.templateName] ?? 0) + row.n;
    }
    return counts;
  }
  return {
    async setQueuedAdmissionReason(id: string, reason: AdmissionReason | null, at: Date) {
      const changed = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
        if (current?.state !== "queued" || current.purgeRequestedAt || current.reasonCode === reason) return false;
        await tx
          .update(workspaces)
          .set({ reasonCode: reason, updatedAt: at, changeSeq: sql`${workspaces.changeSeq}+1` })
          .where(eq(workspaces.id, id));
        return true;
      });
      if (changed) notifyChange(context, id);
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
        if (!(await capacityAdmission(context, tx, claim.workspaceId, claim.at))) return null;
        const [current] = await tx.select().from(workspaces).where(eq(workspaces.id, claim.workspaceId)).for("update");
        if (current?.state !== "queued" || current.purgeRequestedAt) return null;
        const counts = await countActive(tx);
        if (!admissionRoom(counts, current, claim.limits)) return null;
        await reserveCapacityAdmission(context, tx, current.id, current.launchAttempts + 1);
        const [row] = await tx
          .update(workspaces)
          .set({
            state: "provisioning",
            reasonCode: null,
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

function admissionRoom(
  counts: ActiveCounts,
  row: { principalId: string; templateName: string },
  limits: WorkspaceAdmissionClaim["limits"],
) {
  const templateLimit = limits.perTemplateActiveWorkspaces[row.templateName] ?? limits.globalActiveWorkspaces;
  return (
    counts.global < limits.globalActiveWorkspaces &&
    (counts.byPrincipal[row.principalId] ?? 0) < limits.perPrincipalActiveWorkspaces &&
    (counts.byTemplate[row.templateName] ?? 0) < templateLimit
  );
}
