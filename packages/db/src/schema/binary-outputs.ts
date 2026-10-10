import { SCREENSHOT_MAX_BYTES } from "@pstdio/pocketcoder-contracts";
import type { BinaryOutputRow } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import { bytea, check, index, integer, type PgTableFn, text, uuid } from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { timestamptz } from "./columns";
import type { createStorageReservationTables } from "./storage-reservations";
import type { createWorkspaceTables } from "./workspaces";

export function createBinaryOutputTables(
  table: PgTableFn<string | undefined>,
  { principals, machineKeys }: ReturnType<typeof createAccessTables>,
  { workspaces }: ReturnType<typeof createWorkspaceTables>,
  { storageReservations }: ReturnType<typeof createStorageReservationTables>,
) {
  const binaryOutputs = table(
    "binary_outputs",
    {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      keyId: uuid("key_id")
        .notNull()
        .references(() => machineKeys.id),
      reservationId: uuid("reservation_id")
        .notNull()
        .unique()
        .references(() => storageReservations.id),
      connectionEpoch: integer("connection_epoch").notNull(),
      state: text("state").$type<BinaryOutputRow["state"]>().notNull(),
      grantDigest: bytea("grant_digest"),
      data: bytea("data"),
      bytes: integer("bytes"),
      digest: text("digest"),
      expiresAt: timestamptz("expires_at").notNull(),
      retainedUntil: timestamptz("retained_until").notNull(),
      createdAt: timestamptz("created_at").notNull(),
    },
    (row) => [
      check("binary_outputs_state", sql`${row.state} IN ('capturing','ready','deleted')`),
      check(
        "binary_outputs_size",
        sql`${row.data} IS NULL OR octet_length(${row.data}) BETWEEN 1 AND ${SCREENSHOT_MAX_BYTES}`,
      ),
      check("binary_outputs_content", sql`(${row.state} = 'ready') = (${row.data} IS NOT NULL)`),
      index("binary_outputs_workspace").on(row.workspaceId, row.state),
      index("binary_outputs_expiry").on(row.state, row.expiresAt, row.retainedUntil),
    ],
  );
  return { binaryOutputs };
}
