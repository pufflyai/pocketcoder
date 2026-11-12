import { ApiError, managed, TERMINAL_STATES } from "@pstdio/pocketcoder-contracts";
import type {
  WorkspaceInsert,
  WorkspaceInsertResult,
  WorkspaceListFilter,
} from "@pstdio/pocketcoder-runtime-contracts";
import type { SQL } from "drizzle-orm";
import { and, count, desc, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import { type DatabaseContext, lock, type Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { sessionWriter } from "../sessions/observations";
import { appendTransition } from "./events";
import { workspaceFromRow } from "./mapping";

export function createWorkspaces(context: DatabaseContext) {
  const {
    db,
    tables: { workspaces },
    schema,
  } = context;
  async function conflict(tx: Transaction, input: WorkspaceInsert): Promise<WorkspaceInsertResult | null> {
    const [key] = await tx
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.principalId, input.principalId), eq(workspaces.idempotencyKey, input.idempotencyKey)));
    if (key) {
      const workspace = workspaceFromRow(key);
      return key.requestDigest === input.requestDigest
        ? { kind: "replayed", workspace }
        : { kind: "conflict", conflict: "idempotency", workspace };
    }
    const [external] = await tx
      .select()
      .from(workspaces)
      .where(
        and(
          eq(workspaces.principalId, input.principalId),
          eq(workspaces.externalId, input.externalId),
          notInArray(workspaces.state, [...TERMINAL_STATES]),
        ),
      );
    return external ? { kind: "conflict", conflict: "external_id", workspace: workspaceFromRow(external) } : null;
  }
  async function lockSession(tx: Transaction, input: WorkspaceInsert, sessionId: string | undefined) {
    if (!sessionId) return undefined;
    await tx
      .select({ id: context.tables.principals.id })
      .from(context.tables.principals)
      .where(eq(context.tables.principals.id, input.principalId))
      .for("update");
    const session = await sessionWriter(context).read(tx, { principalId: input.principalId, sessionId });
    // Close must either see this queued workspace or fence its insertion before it completes.
    if (session.session.state === "closed") throw new ApiError("session.closed", "Session has ended.");
    return session;
  }
  async function requirePlacement(
    tx: Transaction,
    input: WorkspaceInsert,
    sessionId: string | undefined,
    session: Awaited<ReturnType<ReturnType<typeof sessionWriter>["read"]>>,
  ) {
    const intent = session.placement;
    const [capacity] = await tx
      .select()
      .from(context.tables.managedCapacity)
      .where(eq(context.tables.managedCapacity.workspaceId, input.id))
      .for("update");
    if (
      !intent ||
      intent.workspaceId !== input.id ||
      intent.templateDigest !== input.templateSnapshot.digest ||
      !capacity ||
      capacity.record.principalId !== input.principalId ||
      capacity.record.state !== "reserved" ||
      capacity.record.submitted ||
      !capacity.record.sessions.some(
        (s) => s.sessionId === sessionId && s.generation === intent.generation && !s.stoppedAt,
      )
    )
      throw new ApiError("revision.stale", "Managed placement changed before workspace creation.");
  }
  return {
    async insertWorkspace(
      input: WorkspaceInsert,
      options: { maxQueuedWorkspaces?: number } = {},
    ): Promise<WorkspaceInsertResult> {
      return db.transaction(async (tx) => {
        const sessionId = input.metadata[managed.MANAGED_SESSION_METADATA];
        const session = await lockSession(tx, input, sessionId);
        await lock(tx, `${schema}:workspace-queue`, 7350);
        const existing = await conflict(tx, input);
        if (existing) return existing;
        if (session) await requirePlacement(tx, input, sessionId, session);
        if (options.maxQueuedWorkspaces !== undefined) {
          const [queued] = await tx.select({ count: count() }).from(workspaces).where(eq(workspaces.state, "queued"));
          if (requiredRow(queued).count >= options.maxQueuedWorkspaces) return { kind: "capacity_exceeded" };
        }
        const snapshot = input.templateSnapshot;
        const [row] = await tx
          .insert(workspaces)
          .values({
            ...input,
            templateName: snapshot.name,
            templateVersion: snapshot.version,
            templateDigest: snapshot.digest,
            state: "queued",
            updatedAt: input.createdAt,
            networkState: snapshot.spec.network.mode === "restricted" ? "starting" : "disabled",
          })
          .returning();
        const workspace = workspaceFromRow(requiredRow(row));
        await appendTransition(context, tx, workspace, null, null, input.createdAt);
        return { kind: "created", workspace };
      });
    },
    async getWorkspaceByIdempotency(principalId: string, idempotencyKey: string) {
      const [row] = await db
        .select()
        .from(workspaces)
        .where(and(eq(workspaces.principalId, principalId), eq(workspaces.idempotencyKey, idempotencyKey)));
      return row ? workspaceFromRow(row) : null;
    },
    async getWorkspace(id: string) {
      const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
      return row ? workspaceFromRow(row) : null;
    },
    async listWorkspaces(principalId: string, filter: WorkspaceListFilter) {
      let cursorFilter: SQL | undefined;
      if (filter.cursor) {
        const cursor = db
          .select({ createdAt: workspaces.createdAt, id: workspaces.id })
          .from(workspaces)
          .where(and(eq(workspaces.id, filter.cursor), eq(workspaces.principalId, principalId)));
        cursorFilter = sql`(${workspaces.createdAt}, ${workspaces.id}) < (${cursor})`;
      }
      const rows = await db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.principalId, principalId),
            filter.externalId ? eq(workspaces.externalId, filter.externalId) : undefined,
            filter.state ? eq(workspaces.state, filter.state) : undefined,
            filter.template ? eq(workspaces.templateName, filter.template) : undefined,
            filter.metadata
              ? sql`${workspaces.metadata} @> ${sql.param(filter.metadata, workspaces.metadata)}::jsonb`
              : undefined,
            filter.createdAfter ? gte(workspaces.createdAt, filter.createdAfter) : undefined,
            filter.createdBefore ? lt(workspaces.createdAt, filter.createdBefore) : undefined,
            cursorFilter,
          ),
        )
        .orderBy(desc(workspaces.createdAt), desc(workspaces.id))
        .limit(filter.limit);
      return rows.map(workspaceFromRow);
    },
  };
}
