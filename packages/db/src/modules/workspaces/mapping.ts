import { normalizeTemplateSnapshot } from "@pstdio/pocketcoder-contracts";
import type { DatabaseContext } from "../../database/context";

export function workspaceFromRow(row: DatabaseContext["tables"]["workspaces"]["$inferSelect"]) {
  return {
    ...row,
    templateSnapshot: normalizeTemplateSnapshot(row.templateSnapshot),
  };
}
