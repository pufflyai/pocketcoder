import {
  ApiError,
  digestOf,
  type ExecutionRecord,
  managed,
  PARALLEL_CONVERSATION_CAPABILITIES,
} from "@pstdio/pocketcoder-contracts";
import type { ManagedBinding } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, isNotNull, type SQL } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requireProcessCapacity } from "../budgets/process-capacity";
import { validateConversationExecution } from "../conversations/execution-acceptance";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { settleExecutionFailure } from "../workspaces/execution-failure";
import { pinExecutionInputs } from "../workspaces/execution-inputs";
import { operationAdapterCapabilities, validateExecution } from "../workspaces/execution-validation";
import { sessionHistorySeed } from "./history-seed";
import { pinSessionInputs } from "./request-inputs";
import { writeManagedRequest } from "./request-writer";

type WorkspaceRow = DatabaseContext["tables"]["workspaces"]["$inferSelect"];

// A credentialed session runs work only while its workspace has confirmed its credentials.
const dispatchBinding = (
  session: { binding: ManagedBinding | null; session: { state: string } },
  profile: { issuer?: string },
) => (profile.issuer && session.session.state !== "ready" ? null : session.binding);

// The bound incarnation is live and may still accept work.
const runsBinding = (workspace: WorkspaceRow, incarnationId: string, at: Date) =>
  workspace.state === "ready" &&
  !workspace.runtimeRegistration?.endedAt &&
  !workspace.terminalAt &&
  !workspace.purgeRequestedAt &&
  workspace.deadlineAt > at &&
  workspace.runtimeRegistration?.incarnationId === incarnationId;

import { workAuthority } from "./work-authority";

export async function prepareManagedRequests(context: DatabaseContext, at: Date, seedBytes = 1048576) {
  const table = context.tables.conversationRequests;
  const rows = await context.db.select().from(table).where(isNotNull(table.managed)).orderBy(asc(table.acceptedAt));
  const seen = new Set<string>();
  for (const row of rows
    .filter((row) => row.managed && !row.managed.queueReleased)
    .sort((a, b) => (a.managed?.sequence ?? 0) - (b.managed?.sequence ?? 0))) {
    const sessionKey = `${row.principalId}:${row.conversationId}`;
    if (seen.has(sessionKey)) continue;
    seen.add(sessionKey);
    if (row.execution || !row.managed) continue;
    const acceptingKey = row.managed.keyId;
    await context.db
      .transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const {
          id,
          row: session,
          profile,
        } = await workAuthority(context)(tx, acceptingKey, row.conversationId, "sessions:write");
        const key = and(
          eq(table.principalId, id.principalId),
          eq(table.conversationId, id.sessionId),
          eq(table.requestId, row.requestId),
        );
        const current = await pendingRequest(context, tx, key);
        if (!current) return;
        if (new Date(current.managed.request.dispatchDeadline) <= at) {
          await expireRequest(context, tx, current, at);
          return;
        }
        const binding = dispatchBinding(session, profile);
        if (!binding) return;
        await requireProcessCapacity(context, tx, id, binding, true);
        const [workspace] = await tx
          .select()
          .from(context.tables.workspaces)
          .where(eq(context.tables.workspaces.id, binding.workspaceId))
          .for("update");
        if (!workspace?.runtimeRegistration || !runsBinding(workspace, binding.incarnationId, at)) return;
        const acceptance = await managedAcceptance(
          context,
          tx,
          id,
          current.managed.input,
          current.identity.turn_id,
          workspace,
          binding,
          at,
        );
        validateExecution(workspace, acceptance, at, current.identity);
        const capabilities = operationAdapterCapabilities(workspace, acceptance);
        await validateConversationExecution(
          context,
          tx,
          acceptance,
          current.identity,
          PARALLEL_CONVERSATION_CAPABILITIES.every((cap) => capabilities.includes(cap)),
          true,
        );
        await pinExecutionInputs(context, tx, acceptance, at);
        const seed = await firstTurnSeed(context, tx, rows, current, workspace.id, capabilities, seedBytes);
        const execution: ExecutionRecord = {
          acceptance,
          ...(seed ? { priorMessages: seed.messages } : {}),
          conversationIdentity: current.identity,
          outcome: null,
          acceptedAt: current.acceptedAt.toISOString(),
          dispatchClaimedAt: null,
          phase: "accepted",
          cancel: null,
          settledAt: null,
          acknowledgedAt: null,
          finalizedAt: null,
        };
        await tx.update(table).set({ workspaceId: workspace.id, execution }).where(key);
        await writeManagedRequest(context, tx, current, {
          ...current.managed,
          bindingRevision: session.bindingRevision,
          physicalExecution: execution.acceptance.execution,
          request: {
            ...current.managed.request,
            state: "waiting",
            outcome: null,
            endedAt: null,
            reasonCode: seed?.trimmed ? "context_trimmed" : null,
          },
        });
      })
      .catch(async (error) => {
        // Another conversation can own the serial producer until its finalization completes.
        if (!(error instanceof ApiError)) throw error;
        if (
          error.details?.reason === "previous_request_finalizing" ||
          error.details?.reason === "process_capacity_wait"
        )
          return;
        await context.db.transaction(async (tx) => {
          await lockStorageCapacity(context, tx);
          await tx
            .select()
            .from(context.tables.principals)
            .where(eq(context.tables.principals.id, row.principalId))
            .for("update");
          const request = (
            await tx
              .select()
              .from(table)
              .where(
                and(
                  eq(table.principalId, row.principalId),
                  eq(table.conversationId, row.conversationId),
                  eq(table.requestId, row.requestId),
                ),
              )
          )[0];
          if (request?.managed && !request.execution && !request.managed.queueReleased)
            await expireRequest(context, tx, request, at, "execution_authority_unavailable");
        });
        // A session-specific refusal leaves its durable receipt available for repair
        // and must not stop another session's dispatch or reconciliation.
      });
  }
}
export async function expireRequest(
  context: DatabaseContext,
  tx: Transaction,
  row: DatabaseContext["tables"]["conversationRequests"]["$inferSelect"],
  at: Date,
  reason = "dispatch_deadline_exceeded",
) {
  if (!row.managed) return;
  if (row.execution && !row.execution.producerSendClaimedAt) {
    await settleExecutionFailure(context, tx, row.execution, reason, at);
    return;
  }
  const current = row.managed.request;
  const collection = managed.CollectionResultSchema.parse({
    ...current.collection,
    state: "settled",
    completeness: "lost",
    manifestDigest: digestOf({
      sessionId: current.sessionId,
      requestId: current.requestId,
      reason,
    }),
    errors: [reason],
    settledAt: at.toISOString(),
    expiresAt: at.toISOString(),
  });
  await writeManagedRequest(
    context,
    tx,
    row,
    {
      ...row.managed,
      request: {
        ...current,
        state: "terminal",
        outcome: "failed",
        reasonCode: reason,
        endedAt: at.toISOString(),
        collection,
      },
    },
    true,
  );
}

async function firstTurnSeed(
  context: DatabaseContext,
  tx: Transaction,
  rows: DatabaseContext["tables"]["conversationRequests"]["$inferSelect"][],
  current: DatabaseContext["tables"]["conversationRequests"]["$inferSelect"],
  workspaceId: string,
  capabilities: readonly string[],
  seedBytes: number,
) {
  if (!capabilities.includes("history-seed")) return null;
  const hasRun = rows.some(
    (q) =>
      q.principalId === current.principalId &&
      q.conversationId === current.conversationId &&
      q.requestId !== current.requestId &&
      q.execution?.acceptance.execution.workspaceId === workspaceId &&
      q.execution.producerSendClaimedAt,
  );
  return hasRun ? null : sessionHistorySeed(context, tx, current.principalId, current.conversationId, seedBytes);
}

async function pendingRequest(context: DatabaseContext, tx: Transaction, key: SQL | undefined) {
  const [current] = await tx.select().from(context.tables.conversationRequests).where(key).for("update");
  if (!current?.managed?.input) return null;
  if (current.execution || current.managed.queueReleased) return null;
  return { ...current, managed: { ...current.managed, input: current.managed.input } };
}
async function managedAcceptance(
  context: DatabaseContext,
  tx: Transaction,
  id: import("@pstdio/pocketcoder-runtime-contracts").ManagedSessionIdentity,
  input: managed.RequestInput,
  turnId: string,
  workspace: WorkspaceRow,
  binding: ManagedBinding,
  at: Date,
) {
  const operation = workspace.runtimeRegistration?.template?.manifest.spec.operations.message;
  const adapter = operation && workspace.runtimeRegistration?.template?.manifest.spec.adapters[operation.adapter];
  if (!operation || !adapter) throw new ApiError("operation.conflict", "Managed requests require a message operation.");
  const sources = await pinSessionInputs(context, tx, id, input.attachments, at, true);
  const contents = {
    workspaceId: workspace.id,
    incarnationId: binding.incarnationId,
    objects: sources.map((source) => ({
      ...source,
      storageOwnerId: source.workspaceId,
      workspaceId: workspace.id,
    })),
  };
  const core = {
    execution: {
      workspaceId: workspace.id,
      incarnationId: binding.incarnationId,
      owner: "conversation-request" as const,
      requestId: turnId,
    },
    callerPrincipalId: id.principalId,
    templateDigest: workspace.templateDigest,
    adapterDigest: adapter.digest,
    operation: "message",
    input: { message: input.message },
    inputs: { ...contents, digest: digestOf(contents) },
    bindingSetDigest: digestOf([]),
  };
  return { ...core, fingerprint: digestOf(core) };
}
