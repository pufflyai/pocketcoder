import type { Argv } from "yargs";
import { addResource } from "../command";
import { addImportCommand } from "./import";
import { addListCommand } from "./list";
import { addRenderCommand } from "./render";
import { addValidateCommand } from "./validate";

export function addTemplateCommands(parser: Argv) {
  return addResource(parser, "templates", "Validate and inspect templates", (commands) =>
    addImportCommand(addListCommand(addRenderCommand(addValidateCommand(commands)))),
  );
}
