import type { SqlClient } from "../database/sql-client";

// 0.7.1 wrote some JSON objects as text inside jsonb strings, and 0.8.x decoded them on read.
// 1.0 reads plain JSON, so an upgrade decodes them once. Only columns whose contract is an
// object or array are listed: a string there can only be this legacy encoding.
const STRUCTURED_COLUMNS: Record<string, string[]> = {
  templates: ["spec"],
  conversation_requests: ["identity"],
  workspace_conversation_messages: ["metadata", "identity"],
  workspace_storage: ["provider_ref", "mount_manifest"],
  workspace_checkpoints: ["provider_ref", "template_snapshot", "source_provenance", "manifest"],
  workspaces: [
    "template_snapshot",
    "launch_input",
    "provider_ref",
    "health",
    "metadata",
    "source_descriptor",
    "resolved_source",
    "outputs",
  ],
  warm_pool_runtimes: ["provider_ref"],
};

// The first migration that only 1.0 has. Databases without it were written by 0.x.
export const FIRST_1_0_MIGRATION = "20261005163843_tan_galactus";

export async function normalizeLegacyJson(tx: SqlClient, schema: string) {
  const present = await tx.query<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND data_type = 'jsonb'",
    [schema],
  );
  const jsonb = new Set(present.map((row) => `${row.table_name}.${row.column_name}`));
  for (const [table, columns] of Object.entries(STRUCTURED_COLUMNS)) {
    for (const column of columns.filter((name) => jsonb.has(`${table}.${name}`))) {
      await tx.exec(
        `UPDATE "${schema}"."${table}" SET "${column}" = ("${column}" #>> '{}')::jsonb WHERE jsonb_typeof("${column}") = 'string'`,
      );
    }
  }
}
