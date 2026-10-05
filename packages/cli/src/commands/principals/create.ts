import type { Argv } from "yargs";
import { controlPlaneClient, need, valueList } from "../../command/cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";
import { principalGrantOptions } from "./options";

export function addCreateCommand(parser: Argv) {
  return addAction(
    parser,
    "create",
    "Create a principal",
    (command) =>
      principalGrantOptions(command)
        .option("name", { type: "string", demandOption: true, description: "Principal name" })
        .demandOption("scopes"),
    async (flags) => {
      const principal = await controlPlaneClient().principals.create({
        name: need(flags, "name"),
        scopes: parseScopes(need(flags, "scopes")),
        templates: typeof flags.templates === "string" ? valueList(flags.templates) : [],
      });
      console.log(
        flags.json ? JSON.stringify(principal, null, 2) : `created principal ${principal.name} (${principal.id})`,
      );
    },
  );
}
