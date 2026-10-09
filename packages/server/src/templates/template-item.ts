import type { TemplateRow } from "@pstdio/pocketcoder-runtime-core";

export function safeTemplateItem(row: TemplateRow) {
  return {
    name: row.name,
    version: row.version,
    digest: row.digest,
    ...(row.description ? { description: row.description } : {}),
    status: row.status,
  };
}
