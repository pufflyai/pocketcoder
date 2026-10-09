import type {
  PhysicalStorageAmount,
  ReadStorageCapacity,
  StorageCapacity,
  StorageReservationInput,
  WorkspaceOperationRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { deadlinePreservationExpiry, MAX_CHECKPOINT_PRESERVATION_MS } from "@pstdio/pocketcoder-runtime-contracts";
import { eq, ne, sql } from "drizzle-orm";
import { type DatabaseContext, lock, type QueryContext, type Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { assertUploadPreservationDeadline } from "./upload-preservation-deadline";

export function storageAmount(amount: PhysicalStorageAmount) {
  if (![amount.bytes, amount.files].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("Invalid physical storage amount.");
  return amount;
}

export async function lockStorageCapacity(context: DatabaseContext, tx: Transaction) {
  await lock(tx, `${context.schema}:storage-capacity`, 7353);
}

export async function storageUsage(
  context: DatabaseContext,
  tx: QueryContext,
  workspaceId: string | null,
  principalId: string | null,
) {
  const row = context.tables.storageReservations;
  const [result] = await tx
    .select({
      instanceBytes: sql`coalesce(sum(${row.reservedBytes}), 0)`.mapWith(Number),
      instanceFiles: sql`coalesce(sum(${row.reservedFiles}), 0)`.mapWith(Number),
      workspaceBytes:
        sql`coalesce(sum(case when ${row.workspaceId} = ${workspaceId} then ${row.reservedBytes} else 0 end), 0)`.mapWith(
          Number,
        ),
      workspaceFiles:
        sql`coalesce(sum(case when ${row.workspaceId} = ${workspaceId} then ${row.reservedFiles} else 0 end), 0)`.mapWith(
          Number,
        ),
      principalBytes:
        sql`coalesce(sum(case when ${row.principalId} = ${principalId} then ${row.reservedBytes} else 0 end), 0)`.mapWith(
          Number,
        ),
      principalFiles:
        sql`coalesce(sum(case when ${row.principalId} = ${principalId} then ${row.reservedFiles} else 0 end), 0)`.mapWith(
          Number,
        ),
      outstandingBytes: sql`coalesce(sum(${row.reservedBytes} - ${row.materializedBytes}), 0)`.mapWith(Number),
      outstandingFiles: sql`coalesce(sum(${row.reservedFiles} - ${row.materializedFiles}), 0)`.mapWith(Number),
    })
    .from(row)
    .where(ne(row.state, "released"));
  const value = requiredRow(result);
  return {
    workspace: storageAmount({ bytes: value.workspaceBytes, files: value.workspaceFiles }),
    principal: storageAmount({ bytes: value.principalBytes, files: value.principalFiles }),
    instance: storageAmount({ bytes: value.instanceBytes, files: value.instanceFiles }),
    outstanding: storageAmount({ bytes: value.outstandingBytes, files: value.outstandingFiles }),
  };
}

export function checkStorageCapacity(
  usage: Awaited<ReturnType<typeof storageUsage>>,
  input: StorageReservationInput,
  capacity: StorageCapacity,
) {
  const amount = storageAmount({ bytes: input.reservedBytes, files: input.reservedFiles });
  for (const scope of ["workspace", "principal", "instance"] as const) {
    const maximum = storageAmount(capacity[scope]);
    if (amount.bytes > maximum.bytes - usage[scope].bytes || amount.files > maximum.files - usage[scope].files)
      throw new Error(`Physical storage ${scope} capacity is exhausted.`);
  }
  storageAmount(capacity.freeDisk);
  storageAmount({ bytes: capacity.freeDisk.headroomBytes, files: capacity.freeDisk.headroomFiles });
  // Free space already excludes written and committed data. Subtract only promises still unwritten.
  if (
    amount.bytes > capacity.freeDisk.bytes - capacity.freeDisk.headroomBytes - usage.outstanding.bytes ||
    amount.files > capacity.freeDisk.files - capacity.freeDisk.headroomFiles - usage.outstanding.files
  )
    throw new Error("Physical storage free-disk headroom is exhausted.");
}

export async function admitStorageOwner(
  context: DatabaseContext,
  tx: Transaction,
  input: StorageReservationInput,
  check: () => void,
) {
  const { principals, workspaces, workspaceOperations } = context.tables;
  let deadline: Date | undefined;
  let operation: WorkspaceOperationRow | undefined;
  if (input.operationId) {
    const [found] = await tx
      .select()
      .from(workspaceOperations)
      .where(eq(workspaceOperations.id, input.operationId))
      .for("update");
    operation = found;
    if (
      !operation ||
      operation.principalId !== input.principalId ||
      !["pending", "running"].includes(operation.state) ||
      (input.workspaceId !== operation.workspaceId && input.workspaceId !== operation.resultWorkspaceId)
    )
      throw new Error("Storage reservation operation authority is invalid.");
  }
  if (input.workspaceId) {
    const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).for("update");
    if (!workspace || workspace.principalId !== input.principalId || workspace.purgeRequestedAt || workspace.terminalAt)
      throw new Error("Storage reservation workspace authority is invalid.");
    deadline = workspace.deadlineAt;
    if (input.purpose === "checkpoint-upload" && operation) {
      await assertUploadPreservationDeadline(context, tx, workspace, operation, input.expiresAt);
      deadline = deadlinePreservationExpiry(workspace, operation, MAX_CHECKPOINT_PRESERVATION_MS) ?? deadline;
    }
  }
  if (input.principalId) {
    const [principal] = await tx.select().from(principals).where(eq(principals.id, input.principalId)).for("update");
    if (!principal || principal.disabledAt) throw new Error("Storage reservation principal authority is invalid.");
  }
  check();
  const now = new Date();
  assertStorageExpiry(input.expiresAt, deadline, now);
  return now;
}

function assertStorageExpiry(expiresAt: Date, deadline: Date | undefined, now: Date) {
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    (deadline && (!Number.isFinite(deadline.getTime()) || deadline <= now || expiresAt > deadline))
  )
    throw new Error("Storage reservation deadline is invalid or expired.");
}

export async function reserveStorage(
  context: DatabaseContext,
  tx: Transaction,
  input: StorageReservationInput,
  readCapacity: ReadStorageCapacity,
  check: () => void,
) {
  await lockStorageCapacity(context, tx);
  const at = await admitStorageOwner(context, tx, input, check);
  const usage = await storageUsage(context, tx, input.workspaceId, input.principalId);
  check();
  // Materialization stays locked while free space is sampled, so written bytes cannot be promised again.
  const capacity = await readCapacity();
  checkStorageCapacity(usage, input, capacity);
  check();
  if (input.expiresAt <= new Date()) throw new Error("Storage reservation deadline expired.");
  const [row] = await tx
    .insert(context.tables.storageReservations)
    .values({
      ...input,
      state: "reserved",
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  check();
  if (input.expiresAt <= new Date()) throw new Error("Storage reservation deadline expired.");
  return requiredRow(row);
}
