import type { Argv } from "yargs";
import { withStore } from "../../cli-context";
import { addAction, unchanged } from "../command";

export function addListCommand(parser: Argv) {
  return addAction(parser, "list", "List principals", unchanged, async () => {
    await withStore(async (store) => {
      for (const principal of await store.listPrincipals()) {
        console.log(
          `${principal.name}\t${principal.id}\tscopes=${principal.scopes.join(",")}\ttemplates=${principal.templateNames.join(",") || "-"}${principal.disabledAt ? "\tDISABLED" : ""}`,
        );
      }
    });
  });
}
