import type { ExportObjectReference, WorkloadExecutionReference } from "@pstdio/pocketcoder-contracts";
import { bytea, index, jsonb, type PgTableFn, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";

export function createExportObjectTables(table: PgTableFn<string | undefined>) {
  const exportObjects = table(
    "export_objects",
    {
      id: uuid("id").primaryKey(),
      exportId: uuid("export_id").notNull(),
      workspaceId: uuid("workspace_id").notNull(),
      principalId: uuid("principal_id").notNull(),
      execution: jsonb("execution").$type<WorkloadExecutionReference>().notNull(),
      reference: jsonb("reference").$type<ExportObjectReference>().notNull(),
      data: bytea("data"),
      expiresAt: timestamptz("expires_at").notNull(),
      deletedAt: timestamptz("deleted_at"),
    },
    (row) => [
      index("export_objects_retention").on(row.expiresAt),
      index("export_objects_workspace").on(row.workspaceId),
    ],
  );
  return { exportObjects };
}
