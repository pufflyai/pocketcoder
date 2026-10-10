import { randomUUID } from "node:crypto";
import {
  ApiError,
  parseTemplateManifest,
  runtimeCredentialReferences,
  type TemplateManifest,
  TemplateSpecSchema,
} from "@pstdio/pocketcoder-contracts";
import type { TemplateUpsert } from "@pstdio/pocketcoder-runtime-contracts";
import { assertAuthorityScope } from "@pstdio/pocketcoder-runtime-core";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseContext, Transaction } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { lockKeyAuthority } from "../auth/authority";

export function createTemplates({ db, journal, tables: { templates, principals, machineKeys } }: DatabaseContext) {
  const fromRow = (row: typeof templates.$inferSelect) => ({ ...row, spec: TemplateSpecSchema.parse(row.spec) });
  async function authorize(tx: Transaction, actorKeyId: string, name: string) {
    const { authority } = await lockKeyAuthority(tx, { principals, machineKeys }, actorKeyId);
    assertAuthorityScope(authority, "templates:write");
    if (!authority.templateNames.includes("*") && !authority.templateNames.includes(name)) {
      throw new ApiError("template.not_authorized", "This key cannot administer this template name.");
    }
    return authority;
  }
  async function upsert(tx: Transaction, input: TemplateUpsert) {
    const [existing] = await tx
      .select()
      .from(templates)
      .where(and(eq(templates.name, input.name), eq(templates.version, input.version)))
      .for("update");
    if (existing) return { row: fromRow(existing), created: false, conflict: existing.digest !== input.digest };
    await tx
      .update(templates)
      .set({ status: "available" })
      .where(and(eq(templates.name, input.name), eq(templates.status, "active")));
    const [row] = await tx
      .insert(templates)
      .values({ ...input, id: randomUUID(), status: "active", createdAt: sql`now()` })
      .returning();
    return { row: fromRow(requiredRow(row)), created: true, conflict: false };
  }
  return {
    async upsertTemplate(input: TemplateUpsert) {
      return db.transaction((tx) => upsert(tx, input));
    },
    async publishTemplate(actorKeyId: string, manifest: TemplateManifest) {
      const parsed = parseTemplateManifest(manifest);
      return db.transaction(async (tx) => {
        const { metadata, spec } = parsed.manifest;
        const authority = await authorize(tx, actorKeyId, metadata.name);
        if (
          spec.imagePullSecret ||
          runtimeCredentialReferences(spec).length > 0 ||
          Object.values(spec.source?.repositories ?? {}).some((repository) => repository.credential)
        )
          assertAuthorityScope(authority, "secrets:write");
        const result = await upsert(tx, {
          name: metadata.name,
          version: spec.version,
          digest: parsed.digest,
          description: metadata.description ?? null,
          spec,
        });
        if (result.conflict)
          throw new ApiError("template.version_immutable", "This template version already has different content.");
        return { row: result.row, created: result.created };
      });
    },
    async retireTemplate(actorKeyId: string, name: string, version: string) {
      return db.transaction(async (tx) => {
        await authorize(tx, actorKeyId, name);
        journal?.append({ kind: "template_retired", name, version, at: new Date().toISOString() });
        const [row] = await tx
          .update(templates)
          .set({ status: "retired", retiredAt: sql`coalesce(${templates.retiredAt}, now())` })
          .where(and(eq(templates.name, name), eq(templates.version, version)))
          .returning();
        if (!row) throw new ApiError("template.version_not_found", "Unknown template version.");
        return fromRow(row);
      });
    },
    async listTemplates(names: string[] | null) {
      const rows = await db
        .select()
        .from(templates)
        .where(names ? inArray(templates.name, names) : undefined)
        .orderBy(asc(templates.name), asc(templates.createdAt));
      return rows.map(fromRow);
    },
    async getTemplate(name: string, version?: string) {
      const [row] = await db
        .select()
        .from(templates)
        .where(and(eq(templates.name, name), version ? eq(templates.version, version) : eq(templates.status, "active")))
        .orderBy(desc(templates.createdAt))
        .limit(1);
      return row ? fromRow(row) : null;
    },
  };
}
