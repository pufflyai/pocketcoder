import {
  canonicalJson,
  type FiniteProcessFact,
  FiniteProcessFactSchema,
  isTerminal,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRuntimeRegistration } from "@pstdio/pocketcoder-runtime-contracts";
import { eq, sql } from "drizzle-orm";
import { type DatabaseContext, notifyChange } from "../../database/context";
import { acceptsProcessFact, observedProcessExecution } from "./process-execution-facts";
import { endWorkspaceRuntime } from "./runtime-end";

function canRecord(previous: FiniteProcessFact | null, next: FiniteProcessFact) {
  if (!previous) return true;
  if (
    canonicalJson(previous.execution) !== canonicalJson(next.execution) ||
    previous.fingerprint !== next.fingerprint ||
    previous.claimedAt !== next.claimedAt
  )
    return false;
  if (previous.phase === "exited" || previous.phase === "lost") return canonicalJson(previous) === canonicalJson(next);
  if (previous.phase === "running" && next.phase === "claimed") return false;
  if (
    previous.processGroupId !== null &&
    (previous.processGroupId !== next.processGroupId || previous.startedAt !== next.startedAt)
  )
    return false;
  return true;
}

export function createFiniteProcesses(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces },
  } = context;
  return {
    async bindWorkspaceRuntime(
      id: string,
      runtime: WorkspaceRuntimeRegistration,
      providerRef: Record<string, unknown>,
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
        if (
          !row ||
          row.purgeRequestedAt ||
          isTerminal(row.state) ||
          canonicalJson(row.providerRef) !== canonicalJson(providerRef)
        )
          return false;
        if (runtime.template && runtime.template.digest !== row.templateDigest) return false;
        if (row.runtimeRegistration) {
          const { readyAt: _readyAt, endedAt, ...existing } = row.runtimeRegistration;
          return !endedAt && canonicalJson(existing) === canonicalJson(runtime);
        }
        if (row.state !== "provisioning") return false;
        await tx.update(workspaces).set({ runtimeRegistration: runtime }).where(eq(workspaces.id, id));
        return true;
      });
    },
    async markWorkspaceRuntimeReady(id: string, incarnationId: string, connectionEpoch: number, at: Date) {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
        const runtime = row?.runtimeRegistration;
        if (
          !row ||
          row.purgeRequestedAt ||
          runtime?.incarnationId !== incarnationId ||
          runtime.endedAt ||
          row.connectionEpoch !== connectionEpoch ||
          !["connected", "ready"].includes(row.state)
        )
          return false;
        await tx
          .update(workspaces)
          .set({ runtimeRegistration: { ...runtime, readyAt: runtime.readyAt ?? at.toISOString() } })
          .where(eq(workspaces.id, id));
        return true;
      });
    },
    async recordFiniteProcess(id: string, connectionEpoch: number, input: FiniteProcessFact) {
      const fact = FiniteProcessFactSchema.parse(input);
      const result = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, id)).for("update");
        if (
          !row ||
          row.purgeRequestedAt ||
          row.runtimeRegistration?.endedAt ||
          !["connected", "ready", "terminating"].includes(row.state) ||
          row.connectionEpoch !== connectionEpoch ||
          row.runtimeRegistration?.profile !== "finite-process" ||
          fact.execution.workspaceId !== id ||
          row.runtimeRegistration.incarnationId !== fact.execution.incarnationId ||
          !canRecord(row.finiteProcess, fact)
        )
          return false;
        if (!acceptsProcessFact(row.processExecution, fact)) return false;
        const processExecution = observedProcessExecution(row.processExecution, fact);
        await tx
          .update(workspaces)
          .set({
            processExecution,
            finiteProcess: fact,
            changeSeq: sql`${workspaces.changeSeq}+1`,
            updatedAt: new Date(),
          })
          .where(eq(workspaces.id, id));
        return true;
      });
      if (result) notifyChange(context, id);
      return result;
    },
    endWorkspaceRuntime: (id: string, incarnationId: string, at: Date) =>
      endWorkspaceRuntime(context, id, incarnationId, at),
  };
}
