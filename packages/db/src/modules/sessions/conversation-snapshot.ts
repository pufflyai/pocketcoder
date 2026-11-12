import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { ManagedHistoryStore, ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { workAuthority } from "./work-authority";

type After = Parameters<ManagedHistoryStore["snapshot"]>[2];

export function conversationSnapshot(context: DatabaseContext): ManagedHistoryStore["snapshot"] {
  const { db, tables } = context;
  const {
    conversations,
    conversationRecords: records,
    conversationRequests: requests,
    managedObservations: events,
  } = tables;
  const authorize = workAuthority(context);
  const eventOwner = (id: ManagedSessionIdentity) =>
    and(eq(events.principalId, id.principalId), eq(events.sessionId, id.sessionId));

  async function watermark(tx: Transaction, id: ManagedSessionIdentity, count: number, latest: number, after: After) {
    if (!after) return { from: undefined, reset: false, updates: [] };
    if (after.events > latest)
      throw new ApiError("events.cursor_invalid", "Conversation cursor is ahead of this session.");
    const updates =
      after.events < latest
        ? await tx
            .select({ sequence: events.sequence, event: events.event })
            .from(events)
            .where(and(eventOwner(id), gt(events.sequence, after.events)))
            .orderBy(asc(events.sequence))
        : [];
    // Check the materialized range, not a separate minimum query: pruning can run
    // between queries without taking the session lock.
    const reset =
      after.records > count ||
      updates.length !== latest - after.events ||
      updates.some((event, index) => event.sequence !== after.events + index + 1);
    return { from: reset ? undefined : after, reset, updates };
  }
  async function recordsAfter(tx: Transaction, document: typeof conversations.$inferSelect | undefined, from: After) {
    if (!document || (from && document.recordCount <= from.records)) return [];
    return tx
      .select({ document: records.document })
      .from(records)
      .where(and(eq(records.conversationRef, document.id), from ? gt(records.recordSeq, from.records) : undefined))
      .orderBy(asc(records.recordSeq));
  }
  async function receipts(tx: Transaction, id: ManagedSessionIdentity, from: After, ids: string[]) {
    if (from && !ids.length) return [];
    return tx
      .select()
      .from(requests)
      .where(
        and(
          eq(requests.principalId, id.principalId),
          eq(requests.conversationId, id.sessionId),
          from ? inArray(requests.requestId, ids) : undefined,
        ),
      )
      .orderBy(asc(requests.acceptedAt));
  }
  return (keyId, sessionId, after) =>
    db.transaction(async (tx) => {
      const { id, row } = await authorize(tx, keyId, sessionId, "sessions:read");
      const [document] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.principalId, id.principalId), eq(conversations.conversationId, sessionId)));
      const latest = row.nextSequence - 1;
      const { from, reset, updates } = await watermark(tx, id, document?.recordCount ?? 0, latest, after);
      const changed = await recordsAfter(tx, document, from);
      const requestIds = [
        ...new Set([
          ...updates.flatMap(({ event }) => (event.requestId ? [event.requestId] : [])),
          ...changed.flatMap(({ document }) => (document.request ? [document.request.request_id] : [])),
        ]),
      ];
      const changedRequests = await receipts(tx, id, from, requestIds);
      return {
        session: row.session,
        binding: row.binding,
        requests: changedRequests.flatMap((request) => (request.managed ? [request.managed.request] : [])),
        records: changed.map((record) => record.document),
        eventCursor: `${sessionId}:${latest}`,
        recordCursor: document?.recordCount ?? 0,
        reset,
      };
    });
}
