import {
  ApiError,
  digestOf,
  type ExecutionRecord,
  managed,
  PARALLEL_CONVERSATION_CAPABILITIES,
} from "@pstdio/pocketcoder-contracts";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requireProcessCapacity } from "../budgets/process-capacity";
import { validateConversationExecution } from "../conversations/execution-acceptance";
import { lockStorageCapacity } from "../persistence/reservation-capacity";
import { pinExecutionInputs } from "../workspaces/execution-inputs";
import { operationAdapterCapabilities, validateExecution } from "../workspaces/execution-validation";
import { pinSessionInputs } from "./request-inputs";
import { writeManagedRequest } from "./request-writer";
import { workAuthority } from "./work-authority";

export async function prepareManagedRequests(context: DatabaseContext, at: Date) {
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
        const [current] = await tx.select().from(table).where(key).for("update");
        if (!current?.managed?.input || current.execution || current.managed.queueReleased) return;
        if (new Date(current.managed.input.dispatchDeadline) <= at) {
          await expireRequest(context, tx, current, at);
          return;
        }
        if (!session.binding) return;
        await requireProcessCapacity(context, tx, id, session.binding);
        const [workspace] = await tx
          .select()
          .from(context.tables.workspaces)
          .where(eq(context.tables.workspaces.id, session.binding.workspaceId))
          .for("update");
        if (
          !workspace ||
          workspace.state !== "ready" ||
          workspace.runtimeRegistration?.endedAt ||
          workspace.terminalAt ||
          workspace.purgeRequestedAt ||
          workspace.deadlineAt <= at ||
          workspace.runtimeRegistration?.incarnationId !== session.binding.incarnationId
        )
          return;
        const operation = workspace.runtimeRegistration.template?.manifest.spec.operations.message;
        const adapter = operation && workspace.runtimeRegistration.template?.manifest.spec.adapters[operation.adapter];
        if (!operation || !adapter)
          throw new ApiError("operation.conflict", "Managed requests require a message operation.");
        const sources = await pinSessionInputs(context, tx, id, current.managed.input.attachments, at, true);
        const contents = {
          workspaceId: workspace.id,
          incarnationId: session.binding.incarnationId,
          objects: sources.map((source) => ({
            ...source,
            storageOwnerId: source.workspaceId,
            workspaceId: workspace.id,
          })),
        };
        const core = {
          execution: {
            workspaceId: workspace.id,
            incarnationId: session.binding.incarnationId,
            owner: "conversation-request" as const,
            requestId: current.identity.turn_id,
          },
          callerPrincipalId: id.principalId,
          templateDigest: profile.templateDigest,
          adapterDigest: adapter.digest,
          operation: "message",
          input: { message: current.managed.input.message },
          inputs: { ...contents, digest: digestOf(contents) },
          bindingSetDigest: digestOf([]),
        };
        const acceptance = { ...core, fingerprint: digestOf(core) };
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
        const execution: ExecutionRecord = {
          acceptance,
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
          request: { ...current.managed.request, state: "waiting", outcome: null, endedAt: null, reasonCode: null },
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
async function expireRequest(
  context: DatabaseContext,
  tx: Transaction,
  row: DatabaseContext["tables"]["conversationRequests"]["$inferSelect"],
  at: Date,
  reason = "dispatch_deadline_exceeded",
) {
  if (!row.managed) return;
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
