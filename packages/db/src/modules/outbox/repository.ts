import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";

const CLAIM_LEASE_MS = 60_000;
export function createOutbox({ db, tables: { eventOutbox: outbox } }: DatabaseContext) {
  return {
    async claimDueEvents(now: Date, limit: number) {
      // The update and locked subquery form one statement, so claims stay disjoint.
      const due = db
        .select({ id: outbox.id })
        .from(outbox)
        .where(and(isNull(outbox.deliveredAt), lte(outbox.nextAttemptAt, now)))
        .orderBy(asc(outbox.occurredAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      const rows = await db
        .update(outbox)
        .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_LEASE_MS) })
        .where(inArray(outbox.id, due))
        .returning();
      return rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    },
    async markEventDelivered(id: string, at: Date) {
      await db
        .update(outbox)
        .set({ deliveredAt: at, attemptCount: sql`${outbox.attemptCount}+1` })
        .where(eq(outbox.id, id));
    },
    async markEventFailed(id: string, errorCode: string, nextAttemptAt: Date) {
      await db
        .update(outbox)
        .set({ attemptCount: sql`${outbox.attemptCount}+1`, lastErrorCode: errorCode, nextAttemptAt })
        .where(eq(outbox.id, id));
    },
    async appendEvent(workspaceId: string, eventType: string, payload: unknown, at: Date) {
      await db.insert(outbox).values({
        id: randomUUID(),
        workspaceId,
        eventType,
        payload: payload === null ? sql`'null'::jsonb` : payload,
        occurredAt: at,
        nextAttemptAt: at,
      });
    },
  };
}
