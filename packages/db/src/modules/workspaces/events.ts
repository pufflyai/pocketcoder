import { randomUUID } from "node:crypto";
import type { ReasonCode, WorkspaceState } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-contracts";
import { buildEventEnvelope } from "@pstdio/pocketcoder-runtime-core";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function appendTransition(
  context: DatabaseContext,
  tx: Transaction,
  row: WorkspaceRow,
  from: WorkspaceState | null,
  reason: ReasonCode | null,
  at: Date,
) {
  const history = tx
    .insert(context.tables.workspaceStateHistory)
    .values({
      id: randomUUID(),
      workspaceId: row.id,
      fromState: from,
      toState: row.state,
      reasonCode: reason,
      occurredAt: at,
    })
    .returning({ id: context.tables.workspaceStateHistory.id });
  if (row.purgeRequestedAt) {
    await history;
    return;
  }
  const recorded = tx.$with("recorded_transition").as(history);
  const payload = buildEventEnvelope(row, at);
  await tx.with(recorded).insert(context.tables.eventOutbox).values({
    id: payload.id,
    workspaceId: row.id,
    eventType: payload.type,
    payload,
    occurredAt: at,
    nextAttemptAt: at,
  });
}
