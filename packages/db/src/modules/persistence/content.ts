import { ApiError } from "@pstdio/pocketcoder-contracts";
import { and, eq, notInArray } from "drizzle-orm";
import type { DatabaseContext, QueryContext, Transaction } from "../../database/context";
import { clearConversations, conversationIds } from "../conversations/retention";
import { purgeBinaryOutputs } from "../outputs/binary-output-delete";
import { lockStorageCapacity } from "./reservation-capacity";

// Writers and purge admission take the same row lock. A delayed write cannot
// commit after the deletion fence or race the final database cleanup.
export async function contentWritable(tx: QueryContext, tables: DatabaseContext["tables"], workspaceId: string) {
  const [workspace] = await tx
    .select({ purgeRequestedAt: tables.workspaces.purgeRequestedAt })
    .from(tables.workspaces)
    .where(eq(tables.workspaces.id, workspaceId))
    .for("update");
  return !workspace?.purgeRequestedAt;
}

export async function requireContentWritable(tx: QueryContext, tables: DatabaseContext["tables"], workspaceId: string) {
  if (!(await contentWritable(tx, tables, workspaceId))) {
    throw new ApiError("operation.conflict", "Workspace content is being purged.");
  }
}

export function createContentPurge(context: DatabaseContext) {
  const { db, tables } = context;
  return {
    async listWorkspaceStorage(workspaceId: string) {
      return db.select().from(tables.workspaceStorage).where(eq(tables.workspaceStorage.workspaceId, workspaceId));
    },
    async purgeWorkspaceContent(workspaceId: string, at: Date) {
      await db.transaction(async (tx) => {
        await lockStorageCapacity(context, tx);
        const [workspace] = await tx
          .select()
          .from(tables.workspaces)
          .where(eq(tables.workspaces.id, workspaceId))
          .for("update");
        if (!workspace?.purgeRequestedAt) throw new Error("Purge has not been admitted");
        await purgeBinaryOutputs(context, tx, workspaceId, at);
        await purgeInputMetadata(context, tx, workspaceId);
        await purgeExecutionMetadata(context, tx, workspaceId, workspace.principalId);
        const [pending] = await tx
          .select({ id: tables.workspaceLeases.id })
          .from(tables.workspaceLeases)
          .where(
            and(
              eq(tables.workspaceLeases.workspaceId, workspaceId),
              notInArray(tables.workspaceLeases.state, ["revoked", "expired"]),
            ),
          )
          .limit(1);
        if (pending) throw new Error("Workspace leases remain pending");
        await tx.delete(tables.workspaceLeases).where(eq(tables.workspaceLeases.workspaceId, workspaceId));
        // A purge removes every conversation this workspace wrote to, as a deletion does.
        await clearConversations(context, tx, conversationIds(context, tx, workspaceId), "deleted", at);
        for (const table of [
          tables.workspaceLogs,
          tables.workspaceOutputs,
          tables.workspaceConversationMessages,
          tables.workspaceNetworkEvents,
          tables.eventOutbox,
        ]) {
          await tx.delete(table).where(eq(table.workspaceId, workspaceId));
        }
        await tx
          .insert(tables.workspaceConversations)
          .values({ workspaceId, status: "deleted", deletedAt: at, updatedAt: at })
          .onConflictDoUpdate({
            target: tables.workspaceConversations.workspaceId,
            set: { status: "deleted", expiresAt: null, deletedAt: at, updatedAt: at },
          });
        await tx
          .update(tables.workspaceCheckpoints)
          .set({ manifest: null, manifestDigest: null, sourceProvenance: null, label: null })
          .where(eq(tables.workspaceCheckpoints.workspaceId, workspaceId));
        await tx
          .update(tables.workspaces)
          .set({
            launchInput: null,
            processExecution: null,
            finiteProcess: null,
            outputs: {},
            metadata: {},
            health: {},
            failureLogTail: null,
            failureLogTailTruncated: false,
            failureLastLogSeq: null,
            sourceDescriptor: null,
            resolvedSource: null,
            registrationDigest: null,
            reconnectDigest: null,
            updatedAt: at,
          })
          .where(eq(tables.workspaces.id, workspaceId));
      });
    },
  };
}

async function purgeInputMetadata(context: DatabaseContext, tx: Transaction, workspaceId: string) {
  const { tables } = context;
  const inputs = await tx.select().from(tables.inputObjects).where(eq(tables.inputObjects.workspaceId, workspaceId));
  if (inputs.some((row) => row.state !== "expired")) throw new Error("Canonical input deletion is pending.");
  const manifests = await tx.select().from(tables.inputManifests);
  for (const row of manifests)
    if (row.manifest.workspaceId === workspaceId) {
      if (!row.finalizedAt) throw new Error("Input finalization is pending.");
      await tx.delete(tables.inputManifests).where(eq(tables.inputManifests.id, row.id));
    }
  await tx.delete(tables.inputObjects).where(eq(tables.inputObjects.workspaceId, workspaceId));
}

async function purgeExecutionMetadata(
  context: DatabaseContext,
  tx: Transaction,
  workspaceId: string,
  principalId: string,
) {
  const requests = context.tables.conversationRequests;
  const rows = await tx.select().from(requests).where(eq(requests.principalId, principalId));
  for (const row of rows) {
    if (row.execution?.acceptance.execution.workspaceId !== workspaceId) continue;
    await tx
      .update(requests)
      .set({ execution: null })
      .where(
        and(
          eq(requests.principalId, principalId),
          eq(requests.conversationId, row.conversationId),
          eq(requests.requestId, row.requestId),
        ),
      );
  }
}
