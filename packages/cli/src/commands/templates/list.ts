import type { Argv } from "yargs";
import { controlPlaneClient } from "../../cli-context";
import { addAction } from "../command";

export function addListCommand(parser: Argv) {
  return addAction(
    parser,
    "list",
    "List authorized template versions through the REST API",
    (command) => command.option("json", { type: "boolean", description: "Print JSON" }),
    async (flags) => {
      const items = await controlPlaneClient().templates.list();
      if (flags.json) console.log(JSON.stringify(items, null, 2));
      else {
        for (const item of items) {
          console.log(
            `${item.name}@${item.version}\t${item.status}\t${item.digest.slice(0, 19)}...`,
          );
        }
      }
    },
  );
}
