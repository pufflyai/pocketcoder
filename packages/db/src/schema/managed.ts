import type { managed } from "@pstdio/pocketcoder-contracts";
import type {
  ManagedBinding,
  ManagedCancelRecord,
  ManagedCapacityRecord,
  ManagedPlacementIntent,
} from "@pstdio/pocketcoder-runtime-contracts";
import { bigint, boolean, integer, jsonb, type PgTableFn, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { timestamptz } from "./columns";

export function createManagedTables(
  table: PgTableFn<string | undefined> = pgTable,
  { principals }: ReturnType<typeof createAccessTables>,
) {
  const managedIssuers = table(
    "managed_issuers",
    {
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      name: text("name").notNull(),
      config: jsonb("config").$type<managed.SessionIssuer>().notNull(),
    },
    (row) => [primaryKey({ columns: [row.principalId, row.name] })],
  );
  const managedProfiles = table(
    "managed_profiles",
    {
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      name: text("name").notNull(),
      template: text("template_name").notNull(),
      templateVersion: text("template_version"),
      issuer: text("issuer"),
      placement: text("placement").$type<"exclusive" | "shared">().notNull(),
      workspacesPerOwner: integer("workspaces_per_owner").notNull(),
      sessionsPerWorkspace: integer("sessions_per_workspace").notNull(),
      dispatchDeadlineSeconds: integer("dispatch_deadline_seconds").notNull(),
      disabled: boolean("disabled").notNull().default(false),
      updatedAt: timestamptz("updated_at").notNull(),
    },
    (row) => [primaryKey({ columns: [row.principalId, row.name] })],
  );
  const managedSessions = table(
    "managed_sessions",
    {
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      sessionId: uuid("session_id").notNull(),
      conversationId: uuid("conversation_id").notNull(),
      session: jsonb("session").$type<managed.Session>().notNull(),
      binding: jsonb("binding").$type<ManagedBinding>(),
      bindingRevision: integer("binding_revision").notNull().default(0),
      lastGeneration: integer("last_generation").notNull().default(0),
      nextSequence: bigint("next_sequence", { mode: "number" }).notNull().default(1),
      nextRequestSequence: bigint("next_request_sequence", { mode: "number" }).notNull().default(1),
      queueCount: integer("queue_count").notNull().default(0),
      queueBytes: bigint("queue_bytes", { mode: "number" }).notNull().default(0),
      // Close is persisted once; retries return the same receipt.
      close: jsonb("close").$type<ManagedCancelRecord>(),
      cancel: jsonb("cancel").$type<ManagedCancelRecord>(),
      // The placement owner records the workspace it created before binding, so a restart reuses it.
      placement: jsonb("placement").$type<ManagedPlacementIntent>(),
      resumeRequestedAt: timestamptz("resume_requested_at"),
    },
    (row) => [primaryKey({ columns: [row.principalId, row.sessionId] })],
  );
  const managedObservations = table(
    "managed_observations",
    {
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      sessionId: uuid("session_id").notNull(),
      sequence: bigint("sequence", { mode: "number" }).notNull(),
      event: jsonb("event").$type<managed.RuntimeEvent>().notNull(),
    },
    (row) => [primaryKey({ columns: [row.principalId, row.sessionId, row.sequence] })],
  );
  const managedCapacity = table("managed_capacity", {
    workspaceId: uuid("workspace_id").primaryKey(),
    record: jsonb("record").$type<ManagedCapacityRecord>().notNull(),
  });
  return {
    managedIssuers,
    managedProfiles,
    managedSessions,
    managedObservations,
    managedCapacity,
  };
}
