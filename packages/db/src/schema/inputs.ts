import type { AcceptedInputManifest, InputObjectReference, managed } from "@pstdio/pocketcoder-contracts";
import type { StoredInput } from "@pstdio/pocketcoder-runtime-contracts";
import { bigint, jsonb, type PgTableFn, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { timestamptz } from "./columns";
import type { createStorageReservationTables } from "./storage-reservations";
import type { createWorkspaceTables } from "./workspaces";

export function createInputTables(
  table: PgTableFn<string | undefined>,
  { principals }: ReturnType<typeof createAccessTables>,
  _workspaces: ReturnType<typeof createWorkspaceTables>,
  { storageReservations }: ReturnType<typeof createStorageReservationTables>,
) {
  const inputObjects = table(
    "input_objects",
    {
      // This existing column is the immutable storage namespace. Logical sessions
      // use a separate namespace and never require a placeholder workspace.
      workspaceId: uuid("workspace_id").notNull(),
      sessionId: uuid("session_id"),
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
  const sessionInputs = table(
    "session_inputs",
    {
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      sessionId: uuid("session_id").notNull(),
      inputId: uuid("input_id").notNull(),
      reference: jsonb("reference").$type<managed.InputReference>().notNull(),
      source: jsonb("source").$type<InputObjectReference>().notNull(),
      expiresAt: timestamptz("expires_at").notNull(),
    },
    (row) => [primaryKey({ columns: [row.principalId, row.sessionId, row.inputId] })],
  );
  return { inputObjects, inputManifests, sessionInputs };
}
