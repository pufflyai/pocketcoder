import { pgSchema, pgTable } from "drizzle-orm/pg-core";
import { assertValidSchema } from "../database-schema";
import { createAccessTables } from "./access";
import { createActivityTables } from "./activity";
import { createBinaryOutputTables } from "./binary-outputs";
import { createCheckpointTransferTables } from "./checkpoint-transfers";
import { createConversationTables } from "./conversations";
import { createExportObjectTables } from "./export-objects";
import { createInputTables } from "./inputs";
import { createLeaseTables } from "./leases";
import { createManagedTables } from "./managed";
import { createPersistenceTables } from "./persistence";
import { createPreviewGrantTables } from "./preview-grants";
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
    ...createManagedTables(table, access),
    ...secrets,
    ...createLeaseTables(table, workspaces, secrets),
    ...workspaces,
    ...createActivityTables(table, workspaces, access),
    ...createConversationTables(table, workspaces, access),
    ...persistence,
    ...reservations,
    ...createInputTables(table, access, workspaces, reservations),
    ...createExportObjectTables(table),
    ...createPreviewGrantTables(table),
    ...createBinaryOutputTables(table, access, workspaces, reservations),
    ...createCheckpointTransferTables(table, access, workspaces, persistence, reservations),
    ...createTransferControllerTable(table),
  };
}

// Kit uses unqualified tables; runtime queries use the same definitions with a configured schema.
export const {
  managedScopes,
  managedScopeGrants,
  managedProfiles,
  managedCredentials,
  managedSessions,
  managedObservations,
  managedCapacity,
  budgetPolicies,
  budgetInvocations,
  budgetAudits,
  budgetReports,
  workspaceLeases,
  workspaceLeaseFences,
  secrets,
  secretVersions,
  conversationRequests,
  templates,
  principals,
  machineKeys,
  workspaces,
  workspaceNetworkEvents,
  workspaceTerminalSessions,
  warmPoolRuntimes,
  workspaceOutputs,
  binaryOutputs,
  exportObjects,
  previewGrants,
  workspaceConversations,
  workspaceConversationMessages,
  conversations,
  conversationRecords,
  workspaceStateHistory,
  workspaceLogs,
  eventOutbox,
  workspaceStorage,
  workspaceCheckpoints,
  workspaceOperations,
  checkpointTransfers,
  storageReservations,
  inputObjects,
  inputManifests,
  sessionInputs,
  controllerState,
} = createSchema();
