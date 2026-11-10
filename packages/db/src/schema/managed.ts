import type { managed } from "@pstdio/pocketcoder-contracts";
import type {
  ManagedBinding,
  ManagedCancelRecord,
  ManagedCapacityRecord,
  ManagedCredentialBinding,
  ManagedPlacementIntent,
} from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  type PgTableFn,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { createAccessTables } from "./access";
import { timestamptz } from "./columns";

export function createManagedTables(
  table: PgTableFn<string | undefined> = pgTable,
  { principals }: ReturnType<typeof createAccessTables>,
) {
  const managedScopes = table(
    "managed_scopes",
    {
      scopeId: uuid("scope_id").primaryKey(),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      installation: boolean("installation").notNull(),
      lastClockAt: timestamptz("last_clock_at").notNull(),
    },
    (row) => [uniqueIndex("managed_installation_scope").on(row.installation).where(sql`${row.installation} = true`)],
  );
  const managedScopeGrants = table(
    "managed_scope_grants",
    {
      scopeId: uuid("scope_id")
        .notNull()
        .references(() => managedScopes.scopeId),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
    },
    (row) => [primaryKey({ columns: [row.scopeId, row.principalId] })],
  );
  const managedProfiles = table(
    "managed_profiles",
    {
      profileId: uuid("profile_id").notNull(),
      revision: integer("revision").notNull(),
      principalId: uuid("principal_id")
        .notNull()
        .references(() => principals.id),
      profile: jsonb("profile").$type<managed.ExecutionProfile>().notNull(),
      businessSlots: jsonb("business_slots").$type<string[]>().notNull(),
    },
    (row) => [primaryKey({ columns: [row.profileId, row.revision] })],
  );
  const managedCredentials = table("managed_credentials", {
    bindingId: uuid("binding_id").primaryKey(),
    binding: jsonb("binding")
      .$type<Omit<ManagedCredentialBinding, "authorityExpiresAt"> & { authorityExpiresAt: string }>()
      .notNull(),
  });
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
      // Close is persisted once; retries keep its identity and deadline.
      close: jsonb("close").$type<ManagedCancelRecord>(),
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
  const budgetPolicies = table(
    "budget_policies",
    {
      scopeId: uuid("scope_id")
        .notNull()
        .references(() => managedScopes.scopeId),
      revision: integer("revision").notNull(),
      policy: jsonb("policy").$type<managed.BudgetPolicy>().notNull(),
    },
    (row) => [primaryKey({ columns: [row.scopeId, row.revision] })],
  );
  const managedCapacity = table("managed_capacity", {
    workspaceId: uuid("workspace_id").primaryKey(),
    record: jsonb("record").$type<ManagedCapacityRecord>().notNull(),
  });
  return {
    managedScopes,
    managedScopeGrants,
    managedProfiles,
    managedCredentials,
    managedSessions,
    managedObservations,
    managedCapacity,
    budgetPolicies,
  };
}
