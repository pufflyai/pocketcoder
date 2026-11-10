import type { Argv } from "yargs";
import { addBackupCommands } from "./backup";
import { addBudgetCommands } from "./budgets";
import { addCheckpointCommands } from "./checkpoints";
import { addDatabaseCommands } from "./db";
import { addDoctorCommand } from "./doctor";
import { addKeyCommands } from "./keys";
import { addPoolCommands } from "./pools";
import { addPrincipalCommands } from "./principals";
import { addRecoveryCommands } from "./recovery";
import { addSecretCommands } from "./secrets";
import { addServeCommand } from "./serve";
import { addServerCommands } from "./server";
import { addSessionCommands } from "./sessions";
import { addStorageCommands } from "./storage";
import { addSuperuserCommands } from "./superuser";
import { addTemplateCommands } from "./templates";
import { addWorkspaceCommands } from "./workspaces";

export function addCommands(parser: Argv) {
  const resources = [
    addServeCommand,
    addSuperuserCommands,
    addServerCommands,
    addDatabaseCommands,
    addBackupCommands,
    addRecoveryCommands,
    addPrincipalCommands,
    addKeyCommands,
    addTemplateCommands,
    addSecretCommands,
    addPoolCommands,
    addCheckpointCommands,
    addStorageCommands,
    addWorkspaceCommands,
    addSessionCommands,
    addBudgetCommands,
    addDoctorCommand,
  ];
  return resources.reduce((configured, add) => add(configured), parser);
}
