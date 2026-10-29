import {
  type ConversationMessageIdentity,
  type ConversationRecordStatus,
  ConversationRequestIdentitySchema,
} from "@pstdio/pocketcoder-contracts";
import { asc, eq } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { insertRecord, lockDocument } from "./documents";

type LegacyRow = DatabaseContext["tables"]["workspaceConversationMessages"]["$inferSelect"];

interface Progress {
  workspaces: number;
  messages: number;
  records: number;
}

// Earlier releases stored one row per streamed revision. A turn keeps the last revision of
// each event, in the order the events first appeared.
function latestRevisions(rows: LegacyRow[]) {
  const events = new Map<string, LegacyRow>();
  for (const row of rows) {
    const identity = row.identity as ConversationMessageIdentity;
    const previous = events.get(identity.event_id);
    if (!previous || (previous.identity as ConversationMessageIdentity).revision <= identity.revision)
      events.set(identity.event_id, previous ? { ...row, seq: previous.seq } : row);
  }
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}

function turnStatus(rows: LegacyRow[]): ConversationRecordStatus {
  const terminal = rows.map((row) => row.identity?.fact).findLast((fact) => fact?.type === "turn_terminal");
  return terminal?.type === "turn_terminal" ? terminal.outcome : "legacy";
}

function messageOf(row: LegacyRow) {
  return {
    messageId: row.messageId,
    role: row.role,
    content: row.content,
    occurredAt: row.occurredAt,
    metadata: row.metadata,
    // Validated when it was written; newer schemas must not stop old history from converting.
    identity: (row.identity as ConversationMessageIdentity | null) ?? null,
  };
}

// Converts one workspace at a time and removes its source rows in the same transaction, so the
// step can stop and resume anywhere, and running it again changes nothing.
export async function convertLegacyConversations(
  context: DatabaseContext,
  options: { onProgress?(done: Progress): void } = {},
) {
  const { db } = context;
  const legacy = context.tables.workspaceConversationMessages;
  const done: Progress = { workspaces: 0, messages: 0, records: 0 };
  while (true) {
    const [next] = await db.select({ workspaceId: legacy.workspaceId }).from(legacy).limit(1);
    if (!next) return done;
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(legacy)
        .where(eq(legacy.workspaceId, next.workspaceId))
        .orderBy(asc(legacy.seq))
        .for("update");
      const at = rows[0]?.createdAt ?? new Date();
      const turns = new Map<string, LegacyRow[]>();
      const unidentified: LegacyRow[] = [];
      for (const row of rows) {
        if (!row.identity) unidentified.push(row);
        else turns.set(row.identity.turn_id, [...(turns.get(row.identity.turn_id) ?? []), row]);
      }
      for (const [turnId, turnRows] of turns) {
        const request = ConversationRequestIdentitySchema.parse(turnRows[0]?.identity);
        const document = await lockDocument(context, tx, next.workspaceId, request.conversation_id, at);
        const messages = latestRevisions(turnRows);
        await insertRecord(context, tx, document, {
          workspaceId: next.workspaceId,
          recordKey: turnId,
          request,
          status: turnStatus(messages),
          reason: null,
          messages: messages.map(messageOf),
          startedAt: messages[0]?.occurredAt ?? null,
          endedAt: messages.at(-1)?.occurredAt ?? null,
          createdAt: messages.at(-1)?.createdAt ?? at,
        });
        done.records += 1;
      }
      // ADR 001: history without identity stays unidentified rather than getting made-up IDs.
      if (unidentified.length) {
        const document = await lockDocument(context, tx, next.workspaceId, null, at, true);
        await insertRecord(context, tx, document, {
          workspaceId: next.workspaceId,
          recordKey: "legacy",
          request: null,
          status: "legacy",
          reason: null,
          messages: unidentified.map(messageOf),
          startedAt: unidentified[0]?.occurredAt ?? null,
          endedAt: unidentified.at(-1)?.occurredAt ?? null,
          createdAt: unidentified.at(-1)?.createdAt ?? at,
        });
        done.records += 1;
      }
      await tx.delete(legacy).where(eq(legacy.workspaceId, next.workspaceId));
      done.workspaces += 1;
      done.messages += rows.length;
    });
    options.onProgress?.({ ...done });
  }
}
