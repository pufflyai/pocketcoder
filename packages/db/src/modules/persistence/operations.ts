import type { OperationKind } from "@pstdio/pocketcoder-contracts";
import {
  OperationCapacityExceededError,
  type WorkspaceOperationPatch,
  type WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { type DatabaseContext, lock, type QueryContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function createOperations({
  db,
  schema,
  tables: { workspaceOperations: operations, workspaceCheckpoints: checkpoints },
}: DatabaseContext) {
  const incomplete = inArray(operations.state, ["pending", "running"]);
  async function countIncomplete(tx: QueryContext = db) {
    const [row] = await tx.select({ n: count() }).from(operations).where(incomplete);
    return requiredRow(row).n;
  }
  return {
    async insertOperation(input: WorkspaceOperationRow, options: { maxIncompleteOperations?: number } = {}) {
      return db.transaction(async (tx) => {
        await lock(tx, `${schema}:workspace-operations`, 7352);
        const [existing] = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.principalId, input.principalId),
              eq(operations.kind, input.kind),
              eq(operations.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing)
          return { operation: existing, created: false, conflict: existing.requestDigest !== input.requestDigest };
        if (
          options.maxIncompleteOperations !== undefined &&
          (await countIncomplete(tx)) >= options.maxIncompleteOperations
        )
          throw new OperationCapacityExceededError();
        const [row] = await tx.insert(operations).values(input).returning();
        return { operation: requiredRow(row), created: true, conflict: false };
      });
    },
    async getOperation(id: string) {
      const [row] = await db.select().from(operations).where(eq(operations.id, id));
      return row ?? null;
    },
    async getOperationByIdempotency(principalId: string, kind: OperationKind, idempotencyKey: string) {
      const [row] = await db
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.principalId, principalId),
            eq(operations.kind, kind),
            eq(operations.idempotencyKey, idempotencyKey),
          ),
        );
      return row ?? null;
    },
    async listIncompleteOperations() {
      return db.select().from(operations).where(incomplete).orderBy(asc(operations.createdAt));
    },
    async updateOperation(id: string, patch: WorkspaceOperationPatch, at: Date) {
      await db
        .update(operations)
        .set({ ...patch, updatedAt: at })
        .where(eq(operations.id, id));
    },
    async checkpointUsage(principalId: string | null) {
      const [row] = await db
        .select({ count: count(), logicalBytes: sql`coalesce(sum(${checkpoints.logicalBytes}),0)`.mapWith(Number) })
        .from(checkpoints)
        .where(
          and(
            inArray(checkpoints.state, ["ready", "deleting"]),
            principalId ? eq(checkpoints.principalId, principalId) : undefined,
          ),
        );
      return requiredRow(row);
    },
    countIncompleteOperations: () => countIncomplete(),
  };
}
