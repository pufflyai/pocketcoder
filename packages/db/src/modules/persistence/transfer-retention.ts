import type { CheckpointArchiveHeader } from "@pstdio/pocketcoder-contracts";
import type { CheckpointRetentionLimits } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";

export async function assertCheckpointRetention(
  context: DatabaseContext,
  tx: Transaction,
  header: CheckpointArchiveHeader,
  principalId: string,
  checkpointId: string,
  limits: CheckpointRetentionLimits,
) {
  const checkpoints = context.tables.workspaceCheckpoints;
  const transfers = context.tables.checkpointTransfers;
  const [retained] = await tx
    .select({
      bytes: sql`coalesce(sum(${checkpoints.logicalBytes}), 0)`.mapWith(Number),
      principalBytes:
        sql`coalesce(sum(case when ${checkpoints.principalId} = ${principalId} then ${checkpoints.logicalBytes} else 0 end), 0)`.mapWith(
          Number,
        ),
      principalCount: sql`count(*) filter (where ${checkpoints.principalId} = ${principalId})`.mapWith(Number),
    })
    .from(checkpoints)
    .where(and(ne(checkpoints.id, checkpointId), inArray(checkpoints.state, ["ready", "deleting"])));
  // Headers contain mount totals only. Aggregate live promises in PostgreSQL without loading entry paths.
  const measured = sql`(select coalesce(sum((mount->>'logical_bytes')::bigint), 0) from jsonb_array_elements(${transfers.declaredHeader}->'mounts') mount)`;
  const [promised] = await tx
    .select({
      bytes: sql`coalesce(sum(${measured}), 0)`.mapWith(Number),
      principalBytes:
        sql`coalesce(sum(case when ${transfers.principalId} = ${principalId} then ${measured} else 0 end), 0)`.mapWith(
          Number,
        ),
      principalCount: sql`count(*) filter (where ${transfers.principalId} = ${principalId})`.mapWith(Number),
    })
    .from(transfers)
    .where(
      and(
        ne(transfers.checkpointId, checkpointId),
        eq(transfers.direction, "upload"),
        inArray(transfers.state, ["granted", "streaming", "validated", "publishing", "cleanup_pending"]),
      ),
    );
  const logicalBytes = header.mounts.reduce((sum, mount) => sum + mount.logical_bytes, 0);
  const files = header.mounts.reduce((sum, mount) => sum + mount.file_count, 0);
  if (
    files > limits.maxCheckpointFiles ||
    (retained?.bytes ?? 0) + (promised?.bytes ?? 0) + logicalBytes > limits.maxRetainedBytes ||
    (retained?.principalBytes ?? 0) + (promised?.principalBytes ?? 0) + logicalBytes >
      limits.maxRetainedBytesPerPrincipal ||
    (retained?.principalCount ?? 0) + (promised?.principalCount ?? 0) + 1 > limits.maxCheckpointsPerPrincipal
  )
    throw new Error("checkpoint.quota_exceeded: Checkpoint retention capacity is exhausted.");
}
