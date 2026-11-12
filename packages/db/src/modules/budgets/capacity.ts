import { ApiError, type managed } from "@pstdio/pocketcoder-contracts";
import type { ManagedCapacityRecord, ManagedCapacityStore } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { unavailable } from "../managed/authority-context";
import { sessionWriter } from "../sessions/observations";
import { requireCapacityLaunch } from "./capacity-admission";
import { joinableWorkspace } from "./capacity-join";
import { placeManagedCapacity } from "./capacity-placement";
import { reserveManagedPlacement } from "./capacity-reservation";
import { retireManagedWorkspace } from "./capacity-retirement";

export function createManagedCapacity(context: DatabaseContext, now = () => new Date()): ManagedCapacityStore {
  const { db, tables } = context;
  const table = tables.managedCapacity;
  async function write(tx: Transaction, workspaceId: string, record: ManagedCapacityRecord) {
    await tx
      .insert(table)
      .values({ workspaceId, record })
      .onConflictDoUpdate({ target: table.workspaceId, set: { record } });
  }
  async function lockOwner(tx: Transaction, workspaceId: string, at = now()) {
    const [known] = await tx.select().from(table).where(eq(table.workspaceId, workspaceId));
    if (!known) return null;
    const [principal] = await tx
      .select()
      .from(tables.principals)
      .where(eq(tables.principals.id, known.record.principalId))
      .for("update");
    if (!principal) throw unavailable();
    for (const participant of [...known.record.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
      await sessionWriter(context).read(tx, {
        principalId: known.record.principalId,
        sessionId: participant.sessionId,
      });
    const [current] = await tx.select().from(table).where(eq(table.workspaceId, workspaceId)).for("update");
    return current?.record ?? null;
  }
  async function releaseUnlaunched(workspaceId: string, at: Date) {
    await db.transaction(async (tx) => {
      const record = await lockOwner(tx, workspaceId);
      if (!record || record.state === "released") return;
      const [workspace] = await tx
        .select()
        .from(tables.workspaces)
        .where(eq(tables.workspaces.id, workspaceId))
        .for("update");
      if (!workspace?.terminalAt || workspace.providerRef || workspace.runtimeRegistration || record.submitted) return;
      const cleanup: managed.CleanupReceipt = {
        workspaceId,
        generationId: String(record.launchAttempt),
        revision: 1,
        state: "proved",
        basis: "never_launched",
        observedAt: at.toISOString(),
        capacityReleasedAt: at.toISOString(),
      };
      await write(tx, workspaceId, {
        ...record,
        state: "released",
        sessions: record.sessions.map((session) => ({ ...session, stoppedAt: at.toISOString() })),
        cleanup,
      });
    });
  }
  return {
    retire: (identity, at) => retireManagedWorkspace(context, identity, at),
    reserve: (identity, generation, at) => reserveManagedPlacement(context, identity, generation, at),
    async drains() {
      return (await db.select().from(table))
        .filter((r) => r.record.drainingAt && r.record.state !== "released")
        .map((r) => ({ workspaceId: r.workspaceId, principalId: r.record.principalId }));
    },
    joinable: (identity) => joinableWorkspace(context, identity),
    releaseUnlaunched,
    async reconcile(at) {
      const rows = await db.select().from(table);
      for (const row of rows) if (row.record.state !== "released") await releaseUnlaunched(row.workspaceId, at);
    },
    async managed(workspaceId) {
      const [row] = await db.select().from(table).where(eq(table.workspaceId, workspaceId));
      return !!row;
    },
    place(id) {
      return db.transaction((tx) => placeManagedCapacity(context, tx, id));
    },
    async claimLaunch(workspaceId, attempt, at) {
      at = new Date(at);
      await db.transaction(async (tx) => {
        const record = await lockOwner(tx, workspaceId, at);
        if (!record) return;
        if (record.launchAttempt === attempt && record.submitted) return;
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, workspaceId))
          .for("update");
        if (workspace?.state !== "provisioning" || workspace.launchAttempts !== attempt)
          throw new ApiError("revision.stale", "Launch admission changed.");
        await requireCapacityLaunch(context, tx, record, attempt, at);
        await write(tx, workspaceId, {
          ...record,
          state: "launch_claimed",
          cleanup: null,
          sessions: record.sessions.map((session) => ({ ...session, stoppedAt: null })),
          launchAttempt: attempt,
          submitted: true,
        });
      });
    },
    async notSubmitted(workspaceId, attempt, at) {
      await db.transaction(async (tx) => {
        const record = await lockOwner(tx, workspaceId);
        if (!record) return;
        if (record.launchAttempt > attempt) throw new ApiError("revision.stale", "Launch attempt changed.");
        await write(tx, workspaceId, {
          ...record,
          state: "reserved",
          launchAttempt: attempt,
          submitted: false,
          cleanup: {
            workspaceId,
            generationId: String(attempt),
            revision: 1,
            state: "proved",
            basis: "never_launched",
            observedAt: at.toISOString(),
            capacityReleasedAt: null,
          },
        });
      });
    },
    async cleanupPending(workspaceId, attempt, at) {
      await db.transaction(async (tx) => {
        const record = await lockOwner(tx, workspaceId);
        if (!record || record.cleanup?.capacityReleasedAt) return;
        if (record.launchAttempt !== attempt)
          throw new ApiError("revision.stale", "Cleanup targets a stale launch generation.");
        if (record.cleanup?.state === "pending") return;
        const cleanup: managed.CleanupReceipt = {
          workspaceId,
          generationId: String(attempt),
          revision: 1,
          state: "pending",
          basis: null,
          observedAt: at.toISOString(),
          capacityReleasedAt: null,
        };
        await write(tx, workspaceId, { ...record, state: "cleanup_pending", cleanup });
      });
    },
    async cleanup(workspaceId, attempt, basis, at) {
      return db.transaction(async (tx) => {
        const record = await lockOwner(tx, workspaceId);
        if (!record) return null;
        if (record.launchAttempt !== attempt)
          throw new ApiError("revision.stale", "Cleanup targets a stale launch generation.");
        if (record.cleanup?.capacityReleasedAt) return record.cleanup;
        const cleanup: managed.CleanupReceipt = {
          workspaceId,
          generationId: String(attempt),
          revision: 1,
          state: "proved",
          basis,
          observedAt: at.toISOString(),
          capacityReleasedAt: at.toISOString(),
        };
        await write(tx, workspaceId, {
          ...record,
          state: "released",
          sessions: record.sessions.map((s) => ({ ...s, stoppedAt: s.stoppedAt ?? at.toISOString() })),
          cleanup,
        });
        return cleanup;
      });
    },
    async processStopped(id, incarnationId, at) {
      await db.transaction(async (tx) => {
        const record = await lockOwner(tx, id.workspaceId);
        if (!record) throw unavailable();
        const session = await sessionWriter(context).read(tx, id);
        if (
          session.binding?.workspaceId !== id.workspaceId ||
          session.binding.incarnationId !== incarnationId ||
          session.binding.generation !== id.generation
        )
          throw new ApiError("revision.stale", "Process evidence targets a stale generation.");
        const participant = record.sessions.find((s) => s.sessionId === id.sessionId);
        if (!participant || participant.generation !== id.generation) throw unavailable();
        await write(tx, id.workspaceId, {
          ...record,
          sessions: record.sessions.map((s) =>
            s.sessionId === id.sessionId ? { ...s, stoppedAt: s.stoppedAt ?? at.toISOString() } : s,
          ),
        });
      });
    },
  };
}
