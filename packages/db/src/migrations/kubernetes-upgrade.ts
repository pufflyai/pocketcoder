import { TERMINAL_STATES } from "@pstdio/pocketcoder-contracts";
import type { SqlClient } from "../database/sql-client";

export function decodeProviderRef(value: unknown): Record<string, unknown> | null {
  const ref = typeof value === "string" ? JSON.parse(value) : value;
  return ref && typeof ref === "object" ? (ref as Record<string, unknown>) : null;
}

// Read the old schema too: this check must run before any upgrade writes.
export async function assertKubernetesUpgradeReady(tx: SqlClient, schema: string) {
  const resources = [
    { table: "workspaces", kind: "workspace", driver: "provider_kind", ended: TERMINAL_STATES },
    { table: "warm_pool_runtimes", kind: "warm-runtime", driver: "driver_kind", ended: ["failed"] },
  ];
  const blocked: string[] = [];
  for (const resource of resources) {
    const [relation] = await tx.query<{ relation: string | null }>("SELECT to_regclass($1)::text AS relation", [
      `${schema}.${resource.table}`,
    ]);
    if (!relation?.relation) continue;
    const states = resource.ended.map((_, index) => `$${index + 1}`).join(", ");
    const rows = await tx.query<{ id: string; provider_ref: unknown }>(
      `SELECT id, provider_ref FROM "${schema}"."${resource.table}" WHERE "${resource.driver}" = 'kubernetes' AND state NOT IN (${states}) AND provider_ref IS NOT NULL ORDER BY id`,
      [...resource.ended],
    );
    for (const row of rows) {
      const ref = decodeProviderRef(row.provider_ref);
      const evidence = ref?.terminationEvidence as { neverAdmitted?: { inputUid?: string } } | undefined;
      if (!(typeof ref?.jobUid === "string" && ref.jobUid) && !evidence?.neverAdmitted?.inputUid)
        blocked.push(`${resource.kind} ${row.id}`);
    }
  }
  if (blocked.length)
    throw new Error(
      `Kubernetes Job identity is missing for ${blocked.join(", ")}. Before upgrading, drain these providers with the old release. To bind existing providers, stop all controllers, verify each original Job UID and run pcd db bind-kubernetes-job before retrying. See docs/migration.md.`,
    );
}
