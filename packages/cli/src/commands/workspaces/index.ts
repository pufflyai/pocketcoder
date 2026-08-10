import type { Argv } from "yargs";
import { addResource } from "../command";
import { addAttachCommand } from "./attach";
import { addCancelCommand } from "./cancel";
import { addChatCommand } from "./chat";
import { addCreateCommand } from "./create";
import { addGetCommand } from "./get";
import { addListCommand } from "./list";
import { addLogsCommand } from "./logs";
import { addNetworkEventsCommand } from "./network-events";
import { addOutputsCommand } from "./outputs";
import { addPreserveCommand } from "./preserve";
import { addRecreateCommand } from "./recreate";
import { addRestoreCommand } from "./restore";
import { addTerminalCommand } from "./terminal";
import { addTerminalSessionsCommand } from "./terminal-sessions";

export function addWorkspaceCommands(parser: Argv) {
  const actions = [
    addListCommand,
    addCreateCommand,
    addGetCommand,
    addLogsCommand,
    addNetworkEventsCommand,
    addTerminalSessionsCommand,
    addTerminalCommand,
    addCancelCommand,
    addPreserveCommand,
    addRestoreCommand,
    addRecreateCommand,
    addOutputsCommand,
    addAttachCommand,
    addChatCommand,
  ];
  return addResource(parser, "workspaces", "Manage workspaces", (commands) =>
    actions.reduce((configured, add) => add(configured), commands),
  );
}
