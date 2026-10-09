import { CHECKPOINT_TRANSFER_STATES, type CheckpointTransferRow } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  bytea,
  check,
  index,
  integer,
  jsonb,
  type PgTableFn,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { sqlValues, timestamptz } from "./columns";
import type { createPersistenceTables } from "./persistence";
import type { createStorageReservationTables } from "./storage-reservations";
import type { createWorkspaceTables } from "./workspaces";

export function createCheckpointTransferTables(
  table: PgTableFn<string | undefined>,
  { principals }: ReturnType<typeof createAccessTables>,
  { workspaces }: ReturnType<typeof createWorkspaceTables>,
  { workspaceOperations, workspaceCheckpoints }: ReturnType<typeof createPersistenceTables>,
  { storageReservations }: ReturnType<typeof createStorageReservationTables>,
) {
  const checkpointTransfers = table(
    "checkpoint_transfers",
    {
      id: uuid("id").primaryKey(),
      operationId: uuid("operation_id")
        .notNull()
        .references(() => workspaceOperations.id),
      checkpointId: uuid("checkpoint_id")
        .notNull()
        .references(() => workspaceCheckpoints.id),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      direction: text("direction").$type<CheckpointTransferRow["direction"]>().notNull(),
      connectionEpoch: integer("connection_epoch").notNull(),
      state: text("state").$type<CheckpointTransferRow["state"]>().notNull(),
      requestDigest: text("request_digest").notNull(),
      grantDigest: bytea("grant_digest").$type<Uint8Array>(),
      expiresAt: timestamptz("expires_at").notNull(),
      reservationId: uuid("reservation_id").references(() => storageReservations.id),
      stagePath: text("stage_path"),
      stageIdentity: jsonb("stage_identity").$type<CheckpointTransferRow["stageIdentity"]>(),
      declaredHeader: jsonb("declared_header").$type<CheckpointTransferRow["declaredHeader"]>(),
      expectedArchiveBytes: bigint("expected_archive_bytes", { mode: "number" }),
      summary: jsonb("summary").$type<CheckpointTransferRow["summary"]>(),
      archiveDigest: text("archive_digest"),
      storedBytes: bigint("stored_bytes", { mode: "number" }),
      createdAt: timestamptz("created_at").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
      completedAt: timestamptz("completed_at"),
    },
    (row) => [
      check("checkpoint_transfers_direction_check", sql`${row.direction} IN ('upload', 'download')`),
      check("checkpoint_transfers_state_check", sql`${row.state} IN ${sqlValues(CHECKPOINT_TRANSFER_STATES)}`),
      check("checkpoint_transfers_epoch_check", sql`${row.connectionEpoch} >= 0`),
      check(
        "checkpoint_transfers_digest_check",
        sql`${row.grantDigest} IS NULL OR octet_length(${row.grantDigest}) = 32`,
      ),
      check(
        "checkpoint_transfers_size_check",
        sql`
      (${row.expectedArchiveBytes} IS NULL OR ${row.expectedArchiveBytes} BETWEEN 0 AND 9007199254740991) AND
      (${row.storedBytes} IS NULL OR ${row.storedBytes} BETWEEN 0 AND 9007199254740991)`,
      ),
      check(
        "checkpoint_transfers_grant_phase_check",
        sql`
      (${row.state} = 'granted' AND ${row.grantDigest} IS NOT NULL) OR
      (${row.state} <> 'granted' AND ${row.grantDigest} IS NULL)`,
      ),
      check(
        "checkpoint_transfers_upload_reservation_check",
        sql`
      ${row.direction} <> 'upload' OR ${row.state} = 'preparing' OR ${row.reservationId} IS NOT NULL`,
      ),
      uniqueIndex("checkpoint_transfers_one_live_attempt")
        .on(row.operationId, row.direction)
        .where(sql`${row.state} NOT IN ('complete', 'aborted')`),
      index("checkpoint_transfers_workspace").on(row.workspaceId, row.state),
      index("checkpoint_transfers_reconcile").on(row.state, row.updatedAt),
    ],
  );
  return { checkpointTransfers };
}
