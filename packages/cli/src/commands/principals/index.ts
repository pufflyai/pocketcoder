import type { Argv } from "yargs";
import { addResource } from "../command";
import { addCreateCommand } from "./create";
import { addListCommand } from "./list";
import { addUpdateCommand } from "./update";

export function addPrincipalCommands(parser: Argv) {
  return addResource(parser, "principals", "Manage principals", (commands) =>
    addListCommand(addUpdateCommand(addCreateCommand(commands))),
  );
}
