import type { Argv } from "yargs";
import { addResource } from "../command";
import { addAdmissionMapCommand } from "./admission-map";
import { addCreateCommand } from "./create";
import { addGetCommand } from "./get";
import { addListCommand } from "./list";
import { addPlanCommand } from "./plan";
import { addUpdateCommand } from "./update";

export function addPrincipalCommands(parser: Argv) {
  return addResource(parser, "principals", "Manage principals", (commands) =>
    addAdmissionMapCommand(addPlanCommand(addListCommand(addGetCommand(addUpdateCommand(addCreateCommand(commands)))))),
  );
}
