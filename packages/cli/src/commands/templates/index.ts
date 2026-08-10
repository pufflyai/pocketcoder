import type { Argv } from "yargs";
import { addResource } from "../command";
import { addListCommand } from "./list";
import { addListDatabaseCommand } from "./list-database";
import { addRenderCommand } from "./render";
import { addValidateCommand } from "./validate";

export function addTemplateCommands(parser: Argv) {
  return addResource(parser, "templates", "Validate and inspect templates", (commands) =>
    addListDatabaseCommand(addListCommand(addRenderCommand(addValidateCommand(commands)))),
  );
}
