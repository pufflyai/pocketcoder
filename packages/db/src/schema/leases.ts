import { WORKSPACE_LEASE_STATES, type WorkspaceLeaseRow } from "@pstdio/pocketcoder-runtime-contracts";
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, type PgTableFn, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { sqlValues, timestamptz } from "./columns";
import type { createSecretTables } from "./secrets";
import type { createWorkspaceTables } from "./workspaces";

export function createLeaseTables(
  table: PgTableFn<string | undefined> = pgTable,
  { workspaces }: Pick<ReturnType<typeof createWorkspaceTables>, "workspaces">,
  { secretVersions }: ReturnType<typeof createSecretTables>,
) {
  const workspaceLeaseFences = table("workspace_lease_fences", {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    createdAt: timestamptz("created_at").notNull(),
  });
  const workspaceLeases = table(
    "workspace_leases",
    {
      id: uuid("id").primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      secretName: text("secret_name").notNull(),
      secretVersionId: uuid("secret_version_id").notNull(),
      purpose: text("purpose").$type<WorkspaceLeaseRow["purpose"]>().notNull(),
      sourceUrl: text("source_url"),
      sourceRevision: text("source_revision"),
      templateDigest: text("template_digest").notNull(),
      policyDigest: text("policy_digest").notNull(),
      requestId: uuid("request_id").notNull(),
      requestDigest: text("request_digest").notNull(),
      requestExpiresAt: timestamptz("request_expires_at").notNull(),
      issuerLeaseId: text("issuer_lease_id"),
      issuerExpiresAt: timestamptz("issuer_expires_at"),
      credentialBytes: integer("credential_bytes"),
      state: text("state").$type<WorkspaceLeaseRow["state"]>().notNull(),
      createdAt: timestamptz("created_at").notNull(),
      updatedAt: timestamptz("updated_at").notNull(),
      deliveredAt: timestamptz("delivered_at"),
      closedAt: timestamptz("closed_at"),
    },
    (row) => [
      unique().on(row.secretName, row.requestId),
      foreignKey({
        columns: [row.secretVersionId, row.secretName, row.purpose],
        foreignColumns: [secretVersions.id, secretVersions.name, secretVersions.type],
      }),
      check("workspace_leases_purpose", sql`${row.purpose} IN ('setup-issuer', 'runtime-issuer')`),
      check("workspace_leases_state", sql`${row.state} IN ${sqlValues(WORKSPACE_LEASE_STATES)}`),
      check(
        "workspace_leases_request_expiry",
        sql`${row.requestExpiresAt} > ${row.createdAt} AND ${row.requestExpiresAt} <= ${row.createdAt} + interval '5 minutes'`,
      ),
      check(
        "workspace_leases_issuer_expiry",
        sql`(${row.issuerLeaseId} IS NULL AND ${row.issuerExpiresAt} IS NULL) OR (${row.issuerLeaseId} IS NOT NULL AND ${row.issuerExpiresAt} IS NOT NULL AND ${row.issuerExpiresAt} > ${row.createdAt} AND ${row.issuerExpiresAt} <= ${row.requestExpiresAt})`,
      ),
      check("workspace_leases_closed", sql`(${row.state} IN ('revoked', 'expired')) = (${row.closedAt} IS NOT NULL)`),
      check(
        "workspace_leases_credential_bytes",
        sql`${row.credentialBytes} IS NULL OR ${row.credentialBytes} BETWEEN 1 AND 65536`,
      ),
      check(
        "workspace_leases_acknowledged",
        sql`${row.state} NOT IN ('issued', 'delivered', 'expired') OR (${row.issuerLeaseId} IS NOT NULL AND ${row.credentialBytes} IS NOT NULL)`,
      ),
      index("workspace_leases_workspace").on(row.workspaceId, row.state),
    ],
  );
  return { workspaceLeases, workspaceLeaseFences };
}
