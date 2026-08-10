import type { Argv } from "yargs";
import { fail, need, valueList, withStore } from "../../cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";
import { principalOptions } from "./options";

export function addUpdateCommand(parser: Argv) {
  return addAction(parser, "update", "Update a principal", principalOptions, async (flags) => {
    await withStore(async (store) => {
      const name = need(flags, "name");
      const principal = await store.getPrincipalByName(name);
      if (!principal) fail(`unknown principal: ${name}`);
      const templates =
        typeof flags.templates === "string" ? valueList(flags.templates) : principal.templateNames;
      const updated = await store.updatePrincipal(
        principal.id,
        parseScopes(need(flags, "scopes")),
        templates,
      );
      if (!updated) fail(`unknown principal: ${name}`);
      console.log(`updated principal ${updated.name} (${updated.id})`);
    });
  });
}
