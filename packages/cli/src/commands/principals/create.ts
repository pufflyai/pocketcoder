import type { Argv } from "yargs";
import { need, valueList, withStore } from "../../cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";
import { principalOptions } from "./options";

export function addCreateCommand(parser: Argv) {
  return addAction(parser, "create", "Create a principal", principalOptions, async (flags) => {
    await withStore(async (store) => {
      const row = await store.createPrincipal(
        need(flags, "name"),
        parseScopes(need(flags, "scopes")),
        typeof flags.templates === "string" ? valueList(flags.templates) : [],
      );
      console.log(`created principal ${row.name} (${row.id})`);
    });
  });
}
