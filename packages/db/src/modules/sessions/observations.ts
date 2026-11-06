import { randomUUID } from "node:crypto";
import { ApiError, managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedSessionIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function sessionWriter({ tables }: DatabaseContext) {
  const { managedSessions: sessions, managedObservations: observations } = tables;
  const where = (id: ManagedSessionIdentity) =>
    and(eq(sessions.principalId, id.principalId), eq(sessions.sessionId, id.sessionId));
  async function read(tx: Transaction, id: ManagedSessionIdentity) {
    const [row] = await tx.select().from(sessions).where(where(id)).for("update");
    if (!row) throw new ApiError("session.not_found", "Unknown session.");
    return row;
  }
  async function append(tx: Transaction, id: ManagedSessionIdentity, event: managed.RuntimeEvent) {
    const row = await read(tx, id);
    const parsed = managed.RuntimeEventSchema.parse(event);
    if (parsed.sequence !== row.nextSequence || parsed.sessionId !== id.sessionId)
      throw new ApiError("revision.stale", "Observation sequence changed.");
    await tx.insert(observations).values({ ...id, sequence: row.nextSequence, event: parsed });
    await tx
      .update(sessions)
      .set({ nextSequence: row.nextSequence + 1 })
      .where(where(id));
  }
  async function update(
    tx: Transaction,
    id: ManagedSessionIdentity,
    expectedRevision: number,
    state: managed.Session["state"],
    reasonCode: string | null,
  ) {
    const row = await read(tx, id);
    if (row.session.revision !== expectedRevision) throw new ApiError("revision.stale", "Session revision changed.");
    if (state !== row.session.state && !managed.canTransitionSession(row.session.state, state))
      throw new ApiError("session.closed", "Session state cannot make this transition.");
    const at = new Date().toISOString();
    const session = { ...row.session, revision: expectedRevision + 1, state, reasonCode, updatedAt: at };
    await tx.update(sessions).set({ session }).where(where(id));
    await append(tx, id, {
      eventId: randomUUID(),
      cursor: `${id.sessionId}:${row.nextSequence}`,
      sessionId: id.sessionId,
      requestId: null,
      sequence: row.nextSequence,
      revision: session.revision,
      occurredAt: at,
      recordedAt: at,
      kind: "session.updated",
      data: session,
    });
    return session;
  }
  return {
    read,
    append,
    update,
    where,
    insert: async (tx: Transaction, input: typeof sessions.$inferInsert) =>
      requiredRow((await tx.insert(sessions).values(input).returning())[0]),
  };
}
