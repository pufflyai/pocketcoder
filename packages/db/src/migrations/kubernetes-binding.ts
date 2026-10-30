import type { SqlClient } from "../database/sql-client";
import { assertValidSchema } from "../database-schema";
import { decodeProviderRef } from "./kubernetes-upgrade";

export interface KubernetesBinding {
  kind: "workspace" | "warm-runtime";
  id: string;
  templateDigest: string;
  providerRef: Record<string, unknown>;
}

export interface KubernetesBindingRequest {
  kind: KubernetesBinding["kind"];
  id: string;
  namespace: string;
  jobUid: string;
}

export async function bindKubernetesJob(
  client: SqlClient,
  schema: string,
  request: KubernetesBindingRequest,
  verify: (binding: KubernetesBinding) => Promise<void>,
) {
  assertValidSchema(schema);
  if (!request.jobUid || !request.namespace) throw new Error("An original Job UID and namespace are required");
  const table = request.kind === "workspace" ? "workspaces" : "warm_pool_runtimes";
  const driver = request.kind === "workspace" ? "provider_kind" : "driver_kind";
  return client.transaction(async (tx) => {
    const [lease] = await tx.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 7351)) AS acquired",
      [`${schema}:coordinator`],
    );
    if (!lease?.acquired) throw new Error("Stop the controller before binding a Kubernetes Job");
    const [row] = await tx.query<{ provider_kind: string; provider_ref: unknown; template_digest: string }>(
      `SELECT "${driver}" AS provider_kind, provider_ref, template_digest FROM "${schema}"."${table}" WHERE id = $1 FOR UPDATE`,
      [request.id],
    );
    const ref = decodeProviderRef(row?.provider_ref);
    if (
      row?.provider_kind !== "kubernetes" ||
      !ref ||
      typeof ref.id !== "string" ||
      ref.namespace !== request.namespace
    )
      throw new Error("Kubernetes provider reference or namespace does not match");
    if (ref.jobUid && ref.jobUid !== request.jobUid) throw new Error("Kubernetes Job identity is already bound");
    await verify({ kind: request.kind, id: request.id, providerRef: ref, templateDigest: row.template_digest });
    // Bind as text first so Bun's PostgreSQL client does not encode JSON a second time.
    await tx.query(`UPDATE "${schema}"."${table}" SET provider_ref = ($1::text)::jsonb WHERE id = $2`, [
      JSON.stringify({ ...ref, jobUid: request.jobUid }),
      request.id,
    ]);
  });
}
