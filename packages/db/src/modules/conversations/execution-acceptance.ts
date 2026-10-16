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
  identity?: ConversationRequestIdentity,
) {
  const parsed = ConversationRequestIdentitySchema.parse(identity);
  if (parsed.request_id !== input.execution.requestId) executionConflict("Conversation request ID mismatch.");
  const requests = context.tables.conversationRequests;
  const active = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.principalId, input.callerPrincipalId), isNotNull(requests.execution)));
  if (
    active.some(
      (r) => r.execution?.acceptance.execution.workspaceId === input.execution.workspaceId && !r.execution.finalizedAt,
    )
  )
    executionConflict("Previous request has not finished finalization.");
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

export async function validateExecutionReplay(
  context: DatabaseContext,
  tx: Transaction,
  record: ExecutionRecord,
  input: WorkloadAcceptance,
  identity?: ConversationRequestIdentity,
) {
  if (canonicalJson(record.acceptance) !== canonicalJson(input)) executionConflict("Execution fingerprint conflict.");
  if (input.execution.owner === "process") {
    if (identity) executionConflict("A process has no conversation identity.");
    return;
  }
  const requests = context.tables.conversationRequests;
  const existing = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.principalId, input.callerPrincipalId), eq(requests.requestId, input.execution.requestId)));
  if (!existing.some((r) => canonicalJson(r.identity) === canonicalJson(identity)))
    executionConflict("Conversation identity conflict.");
}
