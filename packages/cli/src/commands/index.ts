import type { Argv } from "yargs";
import { addCheckpointCommands } from "./checkpoints";
import { addDoctorCommand } from "./doctor";
import { addKeyCommands } from "./keys";
import { addPoolCommands } from "./pools";
import { addPrincipalCommands } from "./principals";
import { addServeCommand } from "./serve";
import { addServerCommands } from "./server";
import { addStorageCommands } from "./storage";
import { addSuperuserCommands } from "./superuser";
import { addTemplateCommands } from "./templates";
import { addWorkspaceCommands } from "./workspaces";

export function addCommands(parser: Argv) {
  const resources = [
    addServeCommand,
    addSuperuserCommands,
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
