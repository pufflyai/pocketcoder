import type { Argv } from "yargs";
import { addCheckpointCommands } from "./checkpoints";
import { addDatabaseCommands } from "./db";
import { addDoctorCommand } from "./doctor";
import { addKeyCommands } from "./keys";
import { addPoolCommands } from "./pools";
import { addPrincipalCommands } from "./principals";
import { addServerCommands } from "./server";
import { addStorageCommands } from "./storage";
import { addTemplateCommands } from "./templates";
import { addWorkspaceCommands } from "./workspaces";

export function addCommands(parser: Argv) {
  const resources = [
    addDatabaseCommands,
    addServerCommands,
    addPrincipalCommands,
    addKeyCommands,
    addTemplateCommands,
    addPoolCommands,
    addCheckpointCommands,
    addStorageCommands,
    addWorkspaceCommands,
    addDoctorCommand,
  ];
  return resources.reduce((configured, add) => add(configured), parser);
}
