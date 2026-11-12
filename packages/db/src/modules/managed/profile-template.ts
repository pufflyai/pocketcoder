import { ApiError } from "@pstdio/pocketcoder-contracts";
import { and, eq, ne } from "drizzle-orm";
import type { DatabaseContext, QueryContext } from "../../database/context";

export async function profileTemplate(
  query: QueryContext,
  table: DatabaseContext["tables"]["templates"],
  profile: { template: string; templateVersion?: string | null },
) {
  const [template] = await query
    .select()
    .from(table)
    .where(
      and(
        eq(table.name, profile.template),
        ne(table.status, "retired"),
        profile.templateVersion ? eq(table.version, profile.templateVersion) : eq(table.status, "active"),
      ),
    );
  return template;
}

export function requireProfileTemplate<T extends { templateDigest: string; templateVersion: string | null }>(
  profile: T,
) {
  if (!profile.templateDigest || !profile.templateVersion)
    throw new ApiError("template.not_found", "The session template is unavailable.");
  return { ...profile, templateVersion: profile.templateVersion };
}
