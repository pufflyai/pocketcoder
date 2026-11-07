import {
  type ConversationRequestIdentity,
  ConversationRequestIdentitySchema,
  canonicalJson,
  type ExecutionRecord,
  type WorkloadAcceptance,
} from "@pstdio/pocketcoder-contracts";
import { and, eq, isNotNull } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { executionConflict } from "../workspaces/execution-validation";

export async function validateConversationExecution(
  context: DatabaseContext,
  tx: Transaction,
  input: WorkloadAcceptance,
  identity: ConversationRequestIdentity | undefined,
  parallelConversations: boolean,
  managed = false,
) {
  const parsed = ConversationRequestIdentitySchema.parse(identity);
  const sessions = context.tables.managedSessions;
  const [session] = await tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.principalId, input.callerPrincipalId), eq(sessions.sessionId, parsed.conversation_id)));
  if (session && !managed) executionConflict("Managed sessions use the logical request API.");
  if (parsed.request_id !== input.execution.requestId) {
    const requests = context.tables.conversationRequests;
    const [row] = await tx
      .select()
      .from(requests)
      .where(
        and(
          eq(requests.principalId, input.callerPrincipalId),
          eq(requests.conversationId, parsed.conversation_id),
          eq(requests.requestId, parsed.request_id),
        ),
      );
    if (
      !row?.managed ||
      row.identity.turn_id !== input.execution.requestId ||
      canonicalJson(row.identity) !== canonicalJson(parsed)
    )
      executionConflict("Conversation request ID mismatch.");
  }
  // One request at a time per workspace, or per conversation when the adapter runs conversations in parallel.
  const requests = context.tables.conversationRequests;
  const scope = [eq(requests.principalId, input.callerPrincipalId), isNotNull(requests.execution)];
  if (parallelConversations) scope.push(eq(requests.conversationId, parsed.conversation_id));
  const active = await tx
    .select()
    .from(requests)
    .where(and(...scope));
  if (
    active.some(
      (r) => r.execution?.acceptance.execution.workspaceId === input.execution.workspaceId && !r.execution.finalizedAt,
    )
  )
    // A short wait, not a refusal: clients retry the same request once the earlier one finalizes.
    executionConflict("Previous request has not finished finalization.", { reason: "previous_request_finalizing" });
  return parsed;
}

export async function insertConversationExecution(
  context: DatabaseContext,
  tx: Transaction,
  record: ExecutionRecord,
  identity: ConversationRequestIdentity,
) {
  const requests = context.tables.conversationRequests;
  const key = and(
    eq(requests.principalId, record.acceptance.callerPrincipalId),
    eq(requests.conversationId, identity.conversation_id),
    eq(requests.requestId, identity.request_id),
  );
  const [row] = await tx
    .insert(requests)
    .values({
      principalId: record.acceptance.callerPrincipalId,
      conversationId: identity.conversation_id,
      requestId: identity.request_id,
      identity,
      acceptedAt: new Date(record.acceptedAt),
      execution: record,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return;
  const [previous] = await tx.select().from(requests).where(key);
  if (!previous || canonicalJson(previous.identity) !== canonicalJson(identity) || previous.execution)
    executionConflict("Conversation acceptance fingerprint conflict.");
  await tx.update(requests).set({ execution: record }).where(key);
}

export function validateExecutionReplay(
  record: ExecutionRecord,
  input: WorkloadAcceptance,
  identity?: ConversationRequestIdentity,
) {
  if (canonicalJson(record.acceptance) !== canonicalJson(input)) executionConflict("Execution fingerprint conflict.");
  if (input.execution.owner === "process") {
    if (identity) executionConflict("A process has no conversation identity.");
    return;
  }
  if (canonicalJson(record.conversationIdentity) !== canonicalJson(identity))
    executionConflict("Conversation identity conflict.");
}
