import {
  ApiError,
  canonicalJson,
  type ExecutionPhase,
  type ExecutionRecord,
  ExecutionRecordSchema,
  executionInputManifestId,
  executionNeedsAcknowledgment,
  executionSettled,
  type WorkloadCancel,
  WorkloadCancelSchema,
  type WorkloadExecutionReference,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { eq, isNotNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { requireProcessCapacity } from "../budgets/process-capacity";
import { finalizeInputManifest } from "../persistence/inputs/finalize";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { workAuthority } from "../sessions/work-authority";
import { acceptExecution } from "./execution-acceptance";
import { requireExecutionPrincipal } from "./execution-authority";
import { settleExecutionFailure } from "./execution-failure";
import { requireExecutionInputs } from "./execution-inputs";
import { lockExecutionSession, managedExecutionOwner, readExecution, writeExecution } from "./execution-owners";
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
      await lockExecutionSession(context, tx, execution);
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
        .filter(
          (r) =>
            !executionSettled(r) ||
            executionNeedsAcknowledgment(r) ||
            (r.finalizationBasis === "never_sent" && r.collection?.cleanupState === "pending") ||
            (r.acceptance.execution.owner === "conversation-request" &&
              ["terminal", "canceled"].includes(r.phase) &&
              !r.finalizedAt),
        );
    },
    reconcile(execution: WorkloadExecutionReference) {
      return withOwner(execution, async (_tx, workspace, record) => reconcileExecution(workspace, record));
    },
    claim(execution: WorkloadExecutionReference, at: Date) {
      return withOwner(execution, async (tx, workspace, record) => {
        // An admitted cancel controls an existing claim; it cannot launch work.
        if (record.cancel) return reconcileExecution(workspace, record);
        if (executionSettled(record)) return null;
        try {
          if (!(await managedAdmission(context, tx, record, at))) return null;
          await requireExecutionPrincipal(context, tx, record.acceptance.callerPrincipalId);
          validateExecution(workspace, record.acceptance, at, record.conversationIdentity);
          await requireExecutionInputs(context, tx, record.acceptance);
        } catch (error) {
          await settleClaimFailure(context, tx, record, error, at);
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
    beforeSend(execution: WorkloadExecutionReference, at: Date) {
      return withOwner(execution, async (tx, _workspace, record) => {
        if (executionSettled(record) || record.cancel) return false;
        if (!(await managedAdmission(context, tx, record, at, true))) return false;
        await writeExecution(context, tx, {
          ...record,
          producerSendClaimedAt: record.producerSendClaimedAt ?? at.toISOString(),
        });
        return true;
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
          ...(record.dispatchClaimedAt
            ? {}
            : { phase: "canceled", settledAt: at.toISOString(), finalizedAt: at.toISOString() }),
        };
        if (!record.dispatchClaimedAt && (await managedExecutionOwner(context, tx, input.execution)))
          return settleExecutionFailure(context, tx, next, "canceled_before_dispatch", at);
        await writeExecution(context, tx, next);
        if (!record.dispatchClaimedAt)
          await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
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
        if (
          !executionSettled(record) ||
          ["unknown", "lost"].includes(record.phase) ||
          executionNeedsAcknowledgment(record)
        )
          executionConflict("Unsettled execution cannot pass finalization.");
        await finalizeInputManifest(context, tx, executionInputManifestId(record.acceptance), at);
        await writeExecution(context, tx, { ...record, finalizedAt: record.finalizedAt ?? at.toISOString() });
      });
    },
  };
}

async function managedAdmission(
  context: DatabaseContext,
  tx: Transaction,
  record: ExecutionRecord,
  at: Date,
  sending = false,
) {
  if (record.acceptance.execution.owner === "process") return true;
  const rows = await tx.select().from(context.tables.conversationRequests);
  const row = rows.find(
    (row) =>
      row.managed &&
      row.identity.turn_id === record.acceptance.execution.requestId &&
      row.principalId === record.acceptance.callerPrincipalId,
  );
  if (!row?.managed) return true;
  if (record.producerSendClaimedAt && !sending) return true;
  let reason: string | null = null;
  if (new Date(row.managed.request.dispatchDeadline) <= at) reason = "dispatch_deadline_exceeded";
  else {
    try {
      const authority = await workAuthority(context)(tx, row.managed.keyId, row.conversationId, "sessions:write");
      if (!authority.row.binding || authority.row.bindingRevision !== row.managed.bindingRevision)
        throw new ApiError("operation.conflict", "Session binding changed.");
      await requireProcessCapacity(context, tx, authority.id, authority.row.binding);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      reason = "execution_authority_unavailable";
    }
  }
  if (!reason) return true;
  await settleExecutionFailure(context, tx, record, reason, at);
  return false;
}

function reconcileExecution(workspace: WorkspaceRow, record: ExecutionRecord) {
  const runtime = workspace.runtimeRegistration;
  if (
    !record.dispatchClaimedAt ||
    executionSettled(record) ||
    workspace.principalId !== record.acceptance.callerPrincipalId ||
    workspace.purgeRequestedAt ||
    !runtime?.readyAt ||
    runtime.endedAt ||
    runtime.incarnationId !== record.acceptance.execution.incarnationId
  )
    return null;
  return { first: false as const, record };
}

async function settleClaimFailure(
  context: DatabaseContext,
  tx: Transaction,
  record: ExecutionRecord,
  error: unknown,
  at: Date,
) {
  if (!(error instanceof ApiError)) throw error;
  if (!record.producerSendClaimedAt && (await managedExecutionOwner(context, tx, record.acceptance.execution))) {
    await settleExecutionFailure(context, tx, record, "execution_unavailable", at);
    return;
  }
  await writeExecution(context, tx, { ...record, phase: "lost", settledAt: at.toISOString(), outcome: null });
}
