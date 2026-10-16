import type { AcceptedInputManifest, InputObjectReference } from "@pstdio/pocketcoder-contracts";
import type { StoredInput } from "@pstdio/pocketcoder-runtime-contracts";
import { bigint, jsonb, type PgTableFn, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { timestamptz } from "./columns";
import type { createStorageReservationTables } from "./storage-reservations";
import type { createWorkspaceTables } from "./workspaces";

export function createInputTables(
  table: PgTableFn<string | undefined>,
  { principals }: ReturnType<typeof createAccessTables>,
  { workspaces }: ReturnType<typeof createWorkspaceTables>,
  { storageReservations }: ReturnType<typeof createStorageReservationTables>,
) {
  const inputObjects = table(
    "input_objects",
    {
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      fileId: uuid("file_id").notNull(),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      reservationId: uuid("reservation_id")
        .notNull()
        .references(() => storageReservations.id),
      reference: jsonb("reference").$type<InputObjectReference>().notNull(),
      state: text("state").$type<StoredInput["state"]>().notNull(),
      transferExpiresAt: timestamptz("transfer_expires_at").notNull(),
      retainedUntil: timestamptz("retained_until").notNull(),
      publishedAt: timestamptz("published_at"),
      retentionMs: bigint("retention_ms", { mode: "number" }).notNull(),
    },
    (row) => [primaryKey({ columns: [row.workspaceId, row.fileId] })],
  );
  const inputManifests = table("input_manifests", {
    id: uuid("id").primaryKey(),
    manifest: jsonb("manifest").$type<AcceptedInputManifest>().notNull(),
    finalizedAt: timestamptz("finalized_at"),
  });
  return { inputObjects, inputManifests };
}
