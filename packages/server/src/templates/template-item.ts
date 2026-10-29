import type { TemplateRow } from "@pstdio/pocketcoder-runtime-core";

export function safeTemplateItem(row: TemplateRow) {
  const agent = row.spec.agent;
  return {
    name: row.name,
    version: row.version,
    digest: row.digest,
    agent: agent ? { type: agent.type, model: agent.model ?? null } : null,
    ...(row.description ? { description: row.description } : {}),
    status: row.status,
  };
}
