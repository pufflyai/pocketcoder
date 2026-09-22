import type { WorkspaceOutputRow } from "@pstdio/pocketcoder-runtime-contracts";
import { asc, eq, sql } from "drizzle-orm";
import { type DatabaseContext, lock } from "../../database/context";
import { requiredRow } from "../../database/required-row";
import { structuredJsonValue } from "../../schema/structured-json";
import { requireContentWritable } from "../persistence/content";

export function createOutputs(context: DatabaseContext) {
  const {
    db,
    tables: { workspaceOutputs: outputs, workspaces },
  } = context;
  return {
    async appendOutput(input: WorkspaceOutputRow) {
      return db.transaction(async (tx) => {
        await requireContentWritable(tx, context.tables, input.workspaceId);
        await lock(tx, input.workspaceId, 7081);
        const [latest] = await tx
          .select({ seq: sql`coalesce(max(${outputs.seq}),0)`.mapWith(Number) })
          .from(outputs)
          .where(eq(outputs.workspaceId, input.workspaceId));
        const row = { ...input, seq: requiredRow(latest).seq + 1 };
        await tx.insert(outputs).values({ ...row, value: row.value === null ? sql`'null'::jsonb` : row.value });
        await tx
          .update(workspaces)
          .set({
            outputs: sql`${structuredJsonValue(workspaces.outputs)} || jsonb_build_object(${input.name}::text, ${sql.param(input.value, outputs.value)}::jsonb)`,
            updatedAt: input.occurredAt,
          })
          .where(eq(workspaces.id, input.workspaceId));
        return row;
      });
    },
    async listOutputs(workspaceId: string) {
      return db.select().from(outputs).where(eq(outputs.workspaceId, workspaceId)).orderBy(asc(outputs.seq));
    },
  };
}
