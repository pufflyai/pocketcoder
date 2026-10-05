import type { Argv } from "yargs";
import { controlPlaneClient, need, valueList } from "../../command/cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";
import { principalGrantOptions } from "./options";

export function addUpdateCommand(parser: Argv) {
  return addAction(
    parser,
    "update",
    "Update a principal's grants or disabled status",
    (command) =>
      principalGrantOptions(command)
        .option("id", { type: "string", demandOption: true, description: "Principal ID" })
        .option("disabled", {
          type: "boolean",
          description: "Disable this principal and revoke its keys; false re-enables it",
        })
        .check((flags) => {
          if (flags.scopes === undefined && flags.templates === undefined && flags.disabled === undefined)
            throw new Error("Provide --scopes, --templates or --disabled");
          return true;
        }),
    async (flags) => {
      const principal = await controlPlaneClient().principals.update(need(flags, "id"), {
        ...(typeof flags.scopes === "string" ? { scopes: parseScopes(flags.scopes) } : {}),
        ...(typeof flags.templates === "string" ? { templates: valueList(flags.templates) } : {}),
        ...(typeof flags.disabled === "boolean" ? { disabled: flags.disabled } : {}),
      });
      console.log(
        flags.json ? JSON.stringify(principal, null, 2) : `updated principal ${principal.name} (${principal.id})`,
      );
    },
  );
}
