import { ApiError, digestOf, type ExecutionRecord, executionSettled, managed } from "@pstdio/pocketcoder-contracts";
import type {
  ManagedCancelRecord,
  ManagedSessionIdentity,
  ManagedStopResult,
} from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { pendingWorkspaceLeases } from "../secrets/lease-fence";
import { cancelExecution } from "../workspaces/execution-cancel";
import { sessionWriter } from "./observations";
import { writeManagedRequest } from "./request-writer";
import { ownedWorkspaces } from "./session-workspaces";
import { workAuthority } from "./work-authority";

type RequestRow = DatabaseContext["tables"]["conversationRequests"]["$inferSelect"];

export function cancelReceipt(sessionId: string, requestId: string | null, cancel: ManagedCancelRecord) {
  return managed.CancelReceiptSchema.parse({
    sessionId,
    requestId,
    cancelId: cancel.cancelId,
    scope: requestId === null ? "session" : "request",
    state: cancel.completedAt ? "completed" : "pending",
    acceptedAt: cancel.acceptedAt,
    completedAt: cancel.completedAt,
    cancelDeadline: cancel.cancelDeadline,
  });
}

function stopRecord(cancelId: string, scope: ManagedCancelRecord["scope"], windowMs: number, at: Date) {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0)
    throw new ApiError("validation.invalid", "An explicit cancel window is required.");
  return {
    cancelId,
    scope,
    acceptedAt: at.toISOString(),
    cancelDeadline: new Date(at.getTime() + windowMs).toISOString(),
    completedAt: null,
  };
}

// Each request stopped by a session close gets its own stable execution cancel identity.
function derivedCancelId(closeId: string, requestId: string) {
  const hash = digestOf({ domain: "managed-close/v1", closeId, requestId }).slice(7);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function requestKey(context: DatabaseContext, row: Pick<RequestRow, "principalId" | "conversationId" | "requestId">) {
  const table = context.tables.conversationRequests;
  return and(
    eq(table.principalId, row.principalId),
    eq(table.conversationId, row.conversationId),
    eq(table.requestId, row.requestId),
  );
}

async function reread(context: DatabaseContext, tx: Transaction, row: RequestRow) {
  const [current] = await tx.select().from(context.tables.conversationRequests).where(requestKey(context, row));
  if (!current?.managed) throw new ApiError("request.not_found", "Unknown request.");
  return current;
}

// Persists the stop command once, then ends queued work locally or hands running work to the
// existing targeted-cancel owner. The caller holds the storage and session locks.
async function stopRequest(
  context: DatabaseContext,
  tx: Transaction,
  row: RequestRow,
  cancel: ManagedCancelRecord,
  at: Date,
): Promise<{ cancel: ManagedCancelRecord; execution: ExecutionRecord | null }> {
  if (!row.managed) throw new ApiError("request.not_found", "Unknown request.");
  const known = row.managed.cancel;
  if (known) {
    if (known.cancelId !== cancel.cancelId) throw new ApiError("idempotency.conflict", "Cancel identity changed.");
    const pending = row.execution?.cancel && !executionSettled(row.execution) ? row.execution : null;
    return { cancel: known, execution: pending };
  }
  await writeManagedRequest(context, tx, row, { ...row.managed, cancel });
  let current = await reread(context, tx, row);
  const record = current.managed;
  if (!record || record.request.state === "terminal") return { cancel: record?.cancel ?? cancel, execution: null };
  const executionCancelId =
    cancel.scope === "request" ? cancel.cancelId : derivedCancelId(cancel.cancelId, row.requestId);
  let execution: ExecutionRecord | null = null;
  if (!current.execution) {
    const reason = "canceled_before_dispatch";
    await writeManagedRequest(
      context,
      tx,
      current,
      {
        ...record,
        request: {
          ...record.request,
          state: "terminal",
          outcome: "canceled",
          reasonCode: reason,
          endedAt: at.toISOString(),
          collection: managed.CollectionResultSchema.parse({
            ...record.request.collection,
            state: "settled",
            completeness: "lost",
            manifestDigest: digestOf({ sessionId: row.conversationId, requestId: row.requestId, reason }),
            errors: [reason],
            settledAt: at.toISOString(),
            expiresAt: at.toISOString(),
          }),
        },
      },
      true,
    );
  } else {
    await tx
      .select({ id: context.tables.workspaces.id })
      .from(context.tables.workspaces)
      .where(eq(context.tables.workspaces.id, current.execution.acceptance.execution.workspaceId))
      .for("update");
    execution = await cancelExecution(context, tx, current.execution, executionCancelId, at);
    if (executionSettled(execution) && !execution.dispatchClaimedAt) execution = null;
  }
  current = await reread(context, tx, row);
  return { cancel: current.managed?.cancel ?? cancel, execution };
}

// Close completes once every request of the session is terminal and, for exclusive credentialed
// compute, its workspace has ended with every credential revoked or expired.
async function settleClose(context: DatabaseContext, tx: Transaction, id: ManagedSessionIdentity, at: Date) {
  const { tables } = context;
  const writer = sessionWriter(context);
  const session = await writer.read(tx, id);
  if (!session.close || session.close.completedAt) return session.close;
  const open = await tx
    .select({ requestId: tables.conversationRequests.requestId })
    .from(tables.conversationRequests)
    .where(
      and(
        eq(tables.conversationRequests.principalId, id.principalId),
        eq(tables.conversationRequests.conversationId, id.sessionId),
        isNotNull(tables.conversationRequests.managed),
        sql`${tables.conversationRequests.managed}->'request'->>'state' <> 'terminal'`,
      ),
    )
    .limit(1);
  if (open.length) return session.close;
  const owned = await ownedWorkspaces(context, tx, id, session.binding);
  for (const workspaceId of owned) {
    const [workspace] = await tx.select().from(tables.workspaces).where(eq(tables.workspaces.id, workspaceId));
    const leases = await tx.select().from(tables.workspaceLeases).where(pendingWorkspaceLeases(tables, workspaceId));
    if ((workspace && !workspace.terminalAt) || leases.length) return session.close;
  }
  // On shared compute only this session's process must have stopped; siblings keep the workspace.
  const shared = session.binding && !owned.includes(session.binding.workspaceId) ? session.binding : null;
  if (shared) {
    const [capacity] = await tx
      .select()
      .from(tables.managedCapacity)
      .where(eq(tables.managedCapacity.workspaceId, shared.workspaceId));
    const participant = capacity?.record.sessions.find((s) => s.sessionId === id.sessionId);
    if (participant && !participant.stoppedAt) return session.close;
    const leases = await tx
      .select()
      .from(tables.workspaceLeases)
      .where(pendingWorkspaceLeases(tables, shared.workspaceId));
    if (leases.some((lease) => lease.managedAuthority?.sessionId === id.sessionId)) return session.close;
  }
  const close = { ...session.close, completedAt: at.toISOString() };
  await tx.update(tables.managedSessions).set({ close }).where(writer.where(id));
  return close;
}

// Every unfinished request of the closing session gets the close as its own stop command.
async function stopSessionRequests(
  context: DatabaseContext,
  tx: Transaction,
  id: ManagedSessionIdentity,
  close: ManagedCancelRecord,
  at: Date,
) {
  const table = context.tables.conversationRequests;
  const requests = await tx
    .select()
    .from(table)
    .where(
      and(eq(table.principalId, id.principalId), eq(table.conversationId, id.sessionId), isNotNull(table.managed)),
    );
  const executions: ExecutionRecord[] = [];
  for (const request of requests) {
    if (!request.managed || request.managed.request.state === "terminal") continue;
    const stopped = await stopRequest(
      context,
      tx,
      request,
      request.managed.cancel ?? { ...close, completedAt: null },
      at,
    );
    if (stopped.execution) executions.push(stopped.execution);
  }
  return executions;
}

export function managedStops(context: DatabaseContext) {
  const { db, tables } = context;
  const authorize = workAuthority(context);
  const writer = sessionWriter(context);
  return {
    async cancel(
      keyId: string,
      sessionId: string,
      requestId: string,
      command: managed.CancelCommand,
      windowMs: number,
      at: Date,
    ): Promise<ManagedStopResult> {
      command = managed.CancelCommandSchema.parse(command);
      const proposed = stopRecord(command.cancelId, "request", windowMs, at);
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const { id } = await authorize(tx, keyId, sessionId, "sessions:write");
        const [row] = await tx
          .select()
          .from(tables.conversationRequests)
          .where(requestKey(context, { principalId: id.principalId, conversationId: sessionId, requestId }));
        if (!row?.managed) throw new ApiError("request.not_found", "Unknown request.");
        if (row.managed.cancel?.scope === "session") throw new ApiError("session.closed", "Session is closed.");
        const { cancel, execution } = await stopRequest(context, tx, row, proposed, at);
        return {
          receipt: cancelReceipt(sessionId, requestId, cancel),
          executions: execution ? [execution] : [],
        };
      });
    },
    async close(
      keyId: string,
      sessionId: string,
      command: managed.CancelCommand,
      windowMs: number,
      at: Date,
    ): Promise<ManagedStopResult> {
      command = managed.CancelCommandSchema.parse(command);
      const proposed = stopRecord(command.cancelId, "session", windowMs, at);
      return db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const { id, row } = await authorize(tx, keyId, sessionId, "sessions:write", true);
        if (row.close && row.close.cancelId !== command.cancelId)
          throw new ApiError("idempotency.conflict", "Close identity changed.");
        const close = row.close ?? proposed;
        if (!row.close) {
          // Closing fences acceptance first; history and receipts stay readable.
          await writer.update(tx, id, row.session.revision, "closed", "closed_by_caller");
          await tx.update(tables.managedSessions).set({ close, resumeRequestedAt: null }).where(writer.where(id));
        }
        const executions = await stopSessionRequests(context, tx, id, close, at);
        const settled = (await settleClose(context, tx, id, at)) ?? close;
        return {
          receipt: cancelReceipt(sessionId, null, settled),
          executions,
        };
      });
    },
    // Runs with each dispatcher scan: completes closes whose evidence arrived and marks missed
    // stop deadlines without claiming completion.
    async sweep(at: Date) {
      const closing = await db
        .select({ principalId: tables.managedSessions.principalId, sessionId: tables.managedSessions.sessionId })
        .from(tables.managedSessions)
        .where(
          and(isNotNull(tables.managedSessions.close), sql`${tables.managedSessions.close}->>'completedAt' IS NULL`),
        );
      for (const id of closing) await db.transaction((tx) => settleClose(context, tx, id, at));
      const late = await db
        .select()
        .from(tables.conversationRequests)
        .where(
          and(
            sql`${tables.conversationRequests.managed}->'cancel'->>'completedAt' IS NULL`,
            sql`${tables.conversationRequests.managed}->'cancel'->>'cancelDeadline' <= ${at.toISOString()}`,
            sql`coalesce(${tables.conversationRequests.managed}->'request'->>'reasonCode', '') <> 'cancel_deadline_exceeded'`,
          ),
        );
      for (const row of late)
        await db.transaction(async (tx) => {
          await writer.read(tx, { principalId: row.principalId, sessionId: row.conversationId });
          const current = await reread(context, tx, row);
          if (current.managed) await writeManagedRequest(context, tx, current, current.managed);
        });
    },
  };
}
