import { ApiError, digestOf, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedHistoryStore } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseContext } from "../../database/context";
import { workAuthority } from "./work-authority";

const PageCursorSchema = z.strictObject({
  v: z.literal(1),
  session: z.string(),
  after: z.number().int().min(0),
  upper: z.number().int().min(0),
  events: z.number().int().min(0),
});
type PageCursor = z.infer<typeof PageCursorSchema>;

const invalid = () => new ApiError("events.cursor_invalid", "Cursor does not belong to this session.");
// The cursor names its principal and session through a digest, so it cannot be replayed elsewhere.
const binding = (principalId: string, sessionId: string) =>
  digestOf({ domain: "managed-history/v1", principalId, sessionId }).slice(7, 39);

function encodePage(cursor: PageCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function decodePage(raw: string, expected: string) {
  try {
    const cursor = PageCursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString()));
    if (cursor.session !== expected || cursor.after > cursor.upper) throw invalid();
    return cursor;
  } catch {
    throw invalid();
  }
}
// Event cursors keep the `<sessionId>:<sequence>` form that observations already carry.
export function eventSequence(raw: string, sessionId: string) {
  const [owner, value, extra] = raw.split(":");
  const sequence = Number(value);
  if (extra !== undefined || owner !== sessionId || !Number.isSafeInteger(sequence) || sequence < 0) throw invalid();
  return sequence;
}

export function createManagedHistory(context: DatabaseContext): ManagedHistoryStore {
  const { db, tables } = context;
  const { managedObservations: observations, conversations, conversationRecords: records } = tables;
  const authorize = workAuthority(context);
  return {
    async snapshot(keyId, sessionId) {
      return db.transaction(async (tx) => {
        const { id, row } = await authorize(tx, keyId, sessionId, "sessions:read");
        const [document] = await tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.principalId, id.principalId), eq(conversations.conversationId, sessionId)));
        const items = document
          ? await tx
              .select()
              .from(records)
              .where(eq(records.conversationRef, document.id))
              .orderBy(asc(records.recordSeq))
          : [];
        const q = tables.conversationRequests;
        const requests = await tx
          .select()
          .from(q)
          .where(and(eq(q.principalId, id.principalId), eq(q.conversationId, sessionId)))
          .orderBy(asc(q.acceptedAt));
        return {
          session: row.session,
          binding: row.binding,
          requests: requests.flatMap((q) => (q.managed ? [q.managed.request] : [])),
          records: items.map((r) => r.document),
          eventCursor: `${sessionId}:${row.nextSequence - 1}`,
        };
      });
    },
    // The session row lock orders this read after every terminal commit that holds it, so the
    // records and the event watermark come from one consistent point.
    async history(keyId, sessionId, raw, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new ApiError("validation.invalid", "Limit must be between 1 and 200.");
      return db.transaction(async (tx) => {
        const { id, row } = await authorize(tx, keyId, sessionId, "sessions:read");
        const [document] = await tx
          .select()
          .from(conversations)
          .where(and(eq(conversations.principalId, id.principalId), eq(conversations.conversationId, sessionId)));
        const owner = binding(id.principalId, sessionId);
        const cursor = raw
          ? decodePage(raw, owner)
          : {
              v: 1 as const,
              session: owner,
              after: 0,
              upper: document?.recordCount ?? 0,
              events: row.nextSequence - 1,
            };
        const page = document
          ? await tx
              .select({ seq: records.recordSeq, document: records.document })
              .from(records)
              .where(
                and(
                  eq(records.conversationRef, document.id),
                  gt(records.recordSeq, cursor.after),
                  lte(records.recordSeq, cursor.upper),
                ),
              )
              .orderBy(asc(records.recordSeq))
              .limit(limit)
          : [];
        const last = page.at(-1)?.seq ?? cursor.upper;
        return managed.ManagedHistoryPageSchema.parse({
          records: page.map((record) => record.document),
          nextCursor: last < cursor.upper ? encodePage({ ...cursor, after: last }) : null,
          eventCursor: `${sessionId}:${cursor.events}`,
        });
      });
    },
    // At-least-once replay. Every read rechecks the caller's current authority.
    async events(keyId, sessionId, after, limit) {
      return db.transaction(async (tx) => {
        const { id, row } = await authorize(tx, keyId, sessionId, "sessions:read");
        const from = after === null ? 0 : eventSequence(after, sessionId);
        if (from >= row.nextSequence) throw invalid();
        const where = and(eq(observations.principalId, id.principalId), eq(observations.sessionId, sessionId));
        const [oldest] = await tx
          .select({ sequence: sql<number>`min(${observations.sequence})`.mapWith(Number) })
          .from(observations)
          .where(where);
        const first = oldest?.sequence ?? row.nextSequence;
        if (from + 1 < first)
          throw new ApiError("events.cursor_expired", "Events after this cursor are no longer retained.");
        const rows = await tx
          .select({ event: observations.event })
          .from(observations)
          .where(and(where, gt(observations.sequence, from)))
          .orderBy(asc(observations.sequence))
          .limit(limit);
        return rows.map((r) => r.event);
      });
    },
    // Keeps the newest observations of each session. Replays from older cursors get cursor_expired.
    async prune(keep) {
      if (!Number.isSafeInteger(keep) || keep < 1)
        throw new ApiError("validation.invalid", "Retention must be positive.");
      const { managedSessions: sessions } = tables;
      const removed = await db
        .delete(observations)
        .where(
          sql`${observations.sequence} <= (SELECT s.next_sequence - 1 - ${keep} FROM ${sessions} s
            WHERE s.principal_id = ${observations.principalId} AND s.session_id = ${observations.sessionId})`,
        )
        .returning({ sequence: observations.sequence });
      return removed.length;
    },
  };
}
