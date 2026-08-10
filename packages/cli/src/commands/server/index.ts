import type { Argv } from "yargs";
import { addResource } from "../command";
import { addRunCommand } from "./run";
import { addStartCommand } from "./start";
import { addStatusCommand } from "./status";
import { addStopCommand } from "./stop";

export function addServerCommands(parser: Argv) {
  return addResource(parser, "server", "Manage only the PocketCoder server process", (commands) =>
    addRunCommand(addStopCommand(addStatusCommand(addStartCommand(commands)))),
  );
}
