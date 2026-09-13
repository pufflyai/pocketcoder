import { pgSchema, pgTable } from "drizzle-orm/pg-core";
import { assertValidSchema } from "../database-schema";
import { createAccessTables } from "./access";
import { createActivityTables } from "./activity";
import { createPersistenceTables } from "./persistence";
import { createWorkspaceTables } from "./workspaces";

export function createSchema(schema?: string) {
  const table = schema === undefined ? pgTable : pgSchema(assertValidSchema(schema)).table;
  const access = createAccessTables(table);
  const workspaces = createWorkspaceTables(table, access);
  return {
    ...access,
    ...workspaces,
    ...createActivityTables(table, workspaces),
    ...createPersistenceTables(table, access, workspaces),
  };
}

// Kit uses unqualified tables; runtime queries use the same definitions with a configured schema.
export const {
  templates,
  principals,
  machineKeys,
  workspaces,
  workspaceNetworkEvents,
  workspaceTerminalSessions,
  warmPoolRuntimes,
  workspaceOutputs,
  workspaceConversations,
  workspaceConversationMessages,
  workspaceStateHistory,
  workspaceLogs,
  eventOutbox,
  workspaceStorage,
  workspaceCheckpoints,
  workspaceOperations,
} = createSchema();
