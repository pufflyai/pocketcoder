import type { Argv } from "yargs";
import { addResource } from "../command";
import { addIssueCommand } from "./issue";
import { addRevokeCommand } from "./revoke";

export function addKeyCommands(parser: Argv) {
  return addResource(parser, "keys", "Manage machine keys", (commands) =>
    addRevokeCommand(addIssueCommand(commands)),
  );
}
