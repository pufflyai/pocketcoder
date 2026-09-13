import { TemplateSpecSchema } from "@pstdio/pocketcoder-contracts";
import type { DatabaseContext } from "../../database/context";

export function workspaceFromRow(row: DatabaseContext["tables"]["workspaces"]["$inferSelect"]) {
  return {
    ...row,
    templateSnapshot: { ...row.templateSnapshot, spec: TemplateSpecSchema.parse(row.templateSnapshot.spec) },
  };
}
