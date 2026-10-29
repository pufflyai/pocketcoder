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

// Turns and runs of messages without identity, in the order they were first written, so the
// workspace history reads back in its original order.
function groupsInOrder(rows: LegacyRow[]) {
  const groups: { turnId: string | null; rows: LegacyRow[] }[] = [];
  const turns = new Map<string, { turnId: string; rows: LegacyRow[] }>();
  for (const row of rows) {
    const turnId = row.identity?.turn_id ?? null;
    if (turnId === null) {
      const last = groups.at(-1);
      if (last && last.turnId === null) last.rows.push(row);
      else groups.push({ turnId: null, rows: [row] });
      continue;
    }
    const turn = turns.get(turnId);
    if (turn) turn.rows.push(row);
    else {
      const group = { turnId, rows: [row] };
      turns.set(turnId, group);
      groups.push(group);
    }
  }
  return groups;
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
      for (const group of groupsInOrder(rows)) {
        if (group.turnId) {
          const request = ConversationRequestIdentitySchema.parse(group.rows[0]?.identity);
          const document = await lockDocument(context, tx, next.workspaceId, request.conversation_id, at);
          const messages = latestRevisions(group.rows);
          await insertRecord(context, tx, document, {
            workspaceId: next.workspaceId,
            recordKey: group.turnId,
            request,
            status: turnStatus(messages),
            reason: null,
            messages: messages.map(messageOf),
            startedAt: messages[0]?.occurredAt ?? null,
            endedAt: messages.at(-1)?.occurredAt ?? null,
            createdAt: messages.at(-1)?.createdAt ?? at,
          });
        } else {
          // ADR 001: history without identity stays unidentified rather than getting made-up IDs.
          const document = await lockDocument(context, tx, next.workspaceId, null, at, true);
          await insertRecord(context, tx, document, {
            workspaceId: next.workspaceId,
            recordKey: `legacy:${group.rows[0]?.seq}`,
            request: null,
            status: "legacy",
            reason: null,
            messages: group.rows.map(messageOf),
            startedAt: group.rows[0]?.occurredAt ?? null,
            endedAt: group.rows.at(-1)?.occurredAt ?? null,
            createdAt: group.rows.at(-1)?.createdAt ?? at,
          });
        }
        done.records += 1;
      }
      await tx.delete(legacy).where(eq(legacy.workspaceId, next.workspaceId));
      done.workspaces += 1;
      done.messages += rows.length;
    });
    options.onProgress?.({ ...done });
  }
}
