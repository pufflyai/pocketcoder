import type { Argv } from "yargs";
import { addResource } from "../command";
import { addIssueCommand } from "./issue";
import { addListCommand } from "./list";
import { addRevokeCommand } from "./revoke";
import { addRevokeAllCommand } from "./revoke-all";

export function addKeyCommands(parser: Argv) {
  return addResource(parser, "keys", "Manage machine keys", (commands) =>
    [addIssueCommand, addListCommand, addRevokeCommand, addRevokeAllCommand].reduce(
      (parser, add) => add(parser),
      commands,
    ),
  );
}
