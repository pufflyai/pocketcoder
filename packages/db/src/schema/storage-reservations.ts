import {
  STORAGE_RESERVATION_PURPOSES,
  STORAGE_RESERVATION_STATES,
  type StorageReservationRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import { bigint, check, index, type PgTableFn, text, uuid } from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { sqlValues, timestamptz } from "./columns";
import type { createPersistenceTables } from "./persistence";
import type { createWorkspaceTables } from "./workspaces";

export function createStorageReservationTables(
  table: PgTableFn<string | undefined>,
  { principals }: ReturnType<typeof createAccessTables>,
  { workspaces }: ReturnType<typeof createWorkspaceTables>,
  { workspaceOperations }: ReturnType<typeof createPersistenceTables>,
) {
  const storageReservations = table(
    "storage_reservations",
    {
      id: uuid("id").primaryKey(),
      purpose: text("purpose").$type<StorageReservationRow["purpose"]>().notNull(),
      operationId: uuid("operation_id").references(() => workspaceOperations.id),
      workspaceId: uuid("workspace_id").references(() => workspaces.id),
      principalId: uuid("principal_id").references(() => principals.id),
      state: text("state").$type<StorageReservationRow["state"]>().notNull(),
      reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
      reservedFiles: bigint("reserved_files", { mode: "number" }).notNull(),
      materializedBytes: bigint("materialized_bytes", { mode: "number" }).notNull().default(0),
      materializedFiles: bigint("materialized_files", { mode: "number" }).notNull().default(0),
      expiresAt: timestamptz("expires_at").notNull(),
      createdAt: timestamptz("created_at").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
      releasedAt: timestamptz("released_at"),
    },
    (row) => [
      check("storage_reservations_purpose_check", sql`${row.purpose} IN ${sqlValues(STORAGE_RESERVATION_PURPOSES)}`),
      check("storage_reservations_state_check", sql`${row.state} IN ${sqlValues(STORAGE_RESERVATION_STATES)}`),
      check(
        "storage_reservations_bounds_check",
        sql`
      ${row.reservedBytes} BETWEEN 0 AND 9007199254740991 AND
      ${row.reservedFiles} BETWEEN 0 AND 9007199254740991 AND
      ${row.materializedBytes} BETWEEN 0 AND ${row.reservedBytes} AND
      ${row.materializedFiles} BETWEEN 0 AND ${row.reservedFiles}`,
      ),
      check(
        "storage_reservations_workspace_owner_check",
        sql`${row.workspaceId} IS NULL OR ${row.principalId} IS NOT NULL`,
      ),
      check(
        "storage_reservations_checkpoint_owner_check",
        sql`
      ${row.purpose} NOT IN ('checkpoint-upload', 'checkpoint-index') OR
      (${row.operationId} IS NOT NULL AND ${row.workspaceId} IS NOT NULL AND ${row.principalId} IS NOT NULL)`,
      ),
      index("storage_reservations_active").on(row.state, row.expiresAt),
      index("storage_reservations_workspace").on(row.workspaceId, row.state),
      index("storage_reservations_principal").on(row.principalId, row.state),
    ],
  );
  return { storageReservations };
}
