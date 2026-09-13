import { randomUUID } from "node:crypto";
import { TemplateSpecSchema } from "@pstdio/pocketcoder-contracts";
import type { TemplateStatus, TemplateUpsert } from "@pstdio/pocketcoder-runtime-contracts";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseContext } from "../../database/context";
import { requiredRow } from "../../database/required-row";

export function createTemplates({ db, tables: { templates } }: DatabaseContext) {
  const fromRow = (row: typeof templates.$inferSelect) => ({ ...row, spec: TemplateSpecSchema.parse(row.spec) });
  return {
    async upsertTemplate(input: TemplateUpsert) {
      return db.transaction(async (tx) => {
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
    async setTemplateStatus(name: string, version: string, status: TemplateStatus) {
      await db
        .update(templates)
        .set({ status, retiredAt: status === "retired" ? sql`now()` : null })
        .where(and(eq(templates.name, name), eq(templates.version, version)));
    },
  };
}
