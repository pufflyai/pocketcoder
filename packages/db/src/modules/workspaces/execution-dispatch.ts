import {
  ApiError,
  canonicalJson,
  type ExecutionPhase,
  type ExecutionRecord,
  ExecutionRecordSchema,
  executionSettled,
  type WorkloadCancel,
  WorkloadCancelSchema,
  type WorkloadExecutionReference,
} from "@pstdio/pocketcoder-contracts";
import { eq, isNotNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { acceptExecution } from "./execution-acceptance";
import { requireExecutionPrincipal } from "./execution-authority";
import { requireExecutionInputs } from "./execution-inputs";
import { readExecution, writeExecution } from "./execution-owners";
import { executionConflict, validateExecution } from "./execution-validation";

export function createExecutionDispatch(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces, conversationRequests },
  } = context;
  async function withOwner<T>(
    execution: WorkloadExecutionReference,
    task: (tx: Transaction, workspace: typeof workspaces.$inferSelect, record: ExecutionRecord) => Promise<T>,
  ) {
    return db.transaction(async (tx) => {
      await lockStorageCapacity(context, tx);
      const [workspace] = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, execution.workspaceId))
        .for("update");
      if (!workspace) executionConflict("Execution workspace missing.");
      const record = await readExecution(context, tx, workspace, execution);
      if (!record) executionConflict("Execution was not accepted.");
      return task(tx, workspace, record);
    });
  }
  return {
    accept: acceptExecution(context),
    async get(execution: WorkloadExecutionReference) {
      const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, execution.workspaceId));
      return workspace ? readExecution(context, db, workspace, execution) : null;
    },
    async pending() {
      const rows = await db
        .select({ record: workspaces.processExecution })
        .from(workspaces)
        .where(isNotNull(workspaces.processExecution));
      const requests = await db
        .select({ record: conversationRequests.execution })
        .from(conversationRequests)
        .where(isNotNull(conversationRequests.execution));
      return [...rows, ...requests]
        .map((r) => requiredRow(r.record))
        .filter((r) => !executionSettled(r) || needsAcknowledgment(r));
    },
    claim(execution: WorkloadExecutionReference, at: Date) {
      return withOwner(execution, async (tx, workspace, record) => {
        if (executionSettled(record)) return null;
        try {
          await requireExecutionPrincipal(context, tx, record.acceptance.callerPrincipalId);
          validateExecution(workspace, record.acceptance, at);
          await requireExecutionInputs(context, tx, record.acceptance);
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await writeExecution(context, tx, { ...record, phase: "lost", settledAt: at.toISOString(), outcome: null });
          return null;
        }
        const first = record.dispatchClaimedAt === null;
        const next = {
          ...record,
          dispatchClaimedAt: record.dispatchClaimedAt ?? at.toISOString(),
          phase: first ? ("dispatching" as const) : record.phase,
        };
        await writeExecution(context, tx, next);
        return { first, record: next };
      });
    },
    cancel(input: WorkloadCancel, at: Date) {
      input = WorkloadCancelSchema.parse(input);
      if (input.scope !== "operation") executionConflict("Use workspace release for workspace cancellation.");
      return withOwner(input.execution, async (tx, _workspace, record) => {
        if (record.cancel) {
          if (record.cancel.cancelId !== input.cancelId) executionConflict("Cancel identity conflict.");
          return record;
        }
        if (executionSettled(record)) return record;
        const next: ExecutionRecord = {
          ...record,
          cancel: { cancelId: input.cancelId, requestedAt: at.toISOString() },
          ...(record.dispatchClaimedAt ? {} : { phase: "canceled", settledAt: at.toISOString() }),
        };
        await writeExecution(context, tx, next);
        if (!record.dispatchClaimedAt) await finalizeInputManifest(context, tx, input.execution.requestId, at);
        return next;
      });
    },
    observe(
      execution: WorkloadExecutionReference,
      fingerprint: string,
      phase: ExecutionPhase,
      epoch: number,
      at: Date,
      outcome: unknown = null,
    ) {
      return withOwner(execution, async (tx, workspace, record) => {
        if (
          !record.dispatchClaimedAt ||
          workspace.connectionEpoch !== epoch ||
          workspace.runtimeRegistration?.endedAt ||
          record.acceptance.fingerprint !== fingerprint
        )
          return false;
        if (executionSettled(record))
          return record.phase === phase && canonicalJson(record.outcome) === canonicalJson(outcome);
        if (!["running", "terminal", "unknown", "lost", "canceled"].includes(phase)) return false;
        const settledAt = ["terminal", "unknown", "lost", "canceled"].includes(phase) ? at.toISOString() : null;
        await writeExecution(context, tx, ExecutionRecordSchema.parse({ ...record, phase, settledAt, outcome }));
        return true;
      });
    },
    acknowledge(execution: WorkloadExecutionReference, fingerprint: string, at: Date) {
      return withOwner(execution, async (tx, _workspace, record) => {
        if (record.acceptance.fingerprint !== fingerprint || !executionSettled(record))
          executionConflict("Terminal acknowledgment does not match the execution.");
        await writeExecution(context, tx, { ...record, acknowledgedAt: record.acknowledgedAt ?? at.toISOString() });
      });
    },
    finalize(execution: WorkloadExecutionReference, at: Date) {
      return withOwner(execution, async (tx, _workspace, record) => {
        if (!executionSettled(record) || ["unknown", "lost"].includes(record.phase) || needsAcknowledgment(record))
          executionConflict("Unsettled execution cannot pass finalization.");
        await finalizeInputManifest(context, tx, execution.requestId, at);
        await writeExecution(context, tx, { ...record, finalizedAt: record.finalizedAt ?? at.toISOString() });
      });
    },
  };
}

function needsAcknowledgment(record: ExecutionRecord) {
  return record.dispatchClaimedAt !== null && ["terminal", "canceled"].includes(record.phase) && !record.acknowledgedAt;
}
