import { pgSchema, pgTable } from "drizzle-orm/pg-core";
import { assertValidSchema } from "../database-schema";
import { createAccessTables } from "./access";
import { createActivityTables } from "./activity";
import { createBinaryOutputTables } from "./binary-outputs";
import { createCheckpointTransferTables } from "./checkpoint-transfers";
import { createLeaseTables } from "./leases";
import { createPersistenceTables } from "./persistence";
import { createSecretTables } from "./secrets";
import { createStorageReservationTables } from "./storage-reservations";
import { createTransferControllerTable } from "./transfer-controller";
import { createWorkspaceTables } from "./workspaces";

export function createSchema(schema?: string) {
  const table = schema === undefined ? pgTable : pgSchema(assertValidSchema(schema)).table;
  const access = createAccessTables(table);
  const workspaces = createWorkspaceTables(table, access);
  const secrets = createSecretTables(table);
  const persistence = createPersistenceTables(table, access, workspaces);
  const reservations = createStorageReservationTables(table, access, workspaces, persistence);
  return {
    ...access,
    ...secrets,
    ...createLeaseTables(table, workspaces, secrets),
    ...workspaces,
    ...createActivityTables(table, workspaces),
    ...persistence,
    ...reservations,
    ...createBinaryOutputTables(table, access, workspaces, reservations),
    ...createCheckpointTransferTables(table, access, workspaces, persistence, reservations),
    ...createTransferControllerTable(table),
  };
}

// Kit uses unqualified tables; runtime queries use the same definitions with a configured schema.
export const {
  workspaceLeases,
  workspaceLeaseFences,
  secrets,
  secretVersions,
  templates,
  principals,
  machineKeys,
  workspaces,
  workspaceNetworkEvents,
  workspaceTerminalSessions,
  warmPoolRuntimes,
  workspaceOutputs,
  binaryOutputs,
  workspaceConversations,
  workspaceConversationMessages,
  workspaceStateHistory,
  workspaceLogs,
  eventOutbox,
  workspaceStorage,
  workspaceCheckpoints,
  workspaceOperations,
  checkpointTransfers,
  storageReservations,
  controllerState,
} = createSchema();
