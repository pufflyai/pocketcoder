import type { Argv } from "yargs";
import { addResource } from "../command";
import { addDoctorCommand } from "./doctor";
import { addListOrphansCommand } from "./list-orphans";
import { addPruneCommand } from "./prune";

export function addStorageCommands(parser: Argv) {
  return addResource(parser, "storage", "Inspect and maintain checkpoint storage", (commands) =>
    addPruneCommand(addListOrphansCommand(addDoctorCommand(commands))),
  );
}
