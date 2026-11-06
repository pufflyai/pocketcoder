import { type PgTableFn, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";

export function createPreviewGrantTables(table: PgTableFn<string | undefined> = pgTable) {
  // Grants retain their exact identities even after workspace/key content is purged.
  const previewGrants = table("preview_grants", {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    incarnationId: text("incarnation_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    keyId: uuid("key_id").notNull(),
    subject: text("subject").notNull(),
    accessRevision: text("access_revision").notNull(),
    previews: text("previews").array().notNull(),
    createdAt: timestamptz("created_at").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    ceilingAt: timestamptz("ceiling_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
  });
  return { previewGrants };
}
