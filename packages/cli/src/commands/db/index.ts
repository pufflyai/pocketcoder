import type { Argv } from "yargs";
import { addResource } from "../command";
import { addMigrateCommand } from "./migrate";
import { addStatusCommand } from "./status";

export function addDatabaseCommands(parser: Argv) {
  return addResource(parser, "db", "Manage database migrations", (commands) =>
    addStatusCommand(addMigrateCommand(commands)),
  );
}
