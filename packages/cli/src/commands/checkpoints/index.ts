import type { Argv } from "yargs";
import { addResource } from "../command";
import { addDeleteCommand } from "./delete";
import { addGetCommand } from "./get";
import { addListCommand } from "./list";
import { addVerifyCommand } from "./verify";

export function addCheckpointCommands(parser: Argv) {
  return addResource(parser, "checkpoints", "Inspect retained workspace checkpoints", (commands) =>
    addDeleteCommand(addVerifyCommand(addGetCommand(addListCommand(commands)))),
  );
}
