import type { Argv } from "yargs";
import { controlPlaneClient } from "../../command/cli-context";
import { addAction } from "../command";
import { principalOutputOptions } from "./options";

export function addListCommand(parser: Argv) {
  return addAction(parser, "list", "List principals", principalOutputOptions, async (flags) => {
    const result = await controlPlaneClient().principals.list();
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    for (const principal of result.items) {
      console.log(
        `${principal.name}\t${principal.id}\tscopes=${principal.scopes.join(",")}\ttemplates=${principal.templates.join(",") || "-"}${principal.disabled_at ? "\tDISABLED" : ""}`,
      );
    }
  });
}
