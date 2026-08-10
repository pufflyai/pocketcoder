import type { Argv } from "yargs";
import { withStore } from "../../cli-context";
import { addAction, unchanged } from "../command";

export function addListDatabaseCommand(parser: Argv) {
  return addAction(
    parser,
    "list-database",
    "List every template version from PostgreSQL",
    unchanged,
    async () => {
      await withStore(async (store) => {
        for (const item of await store.listTemplates(null)) {
          console.log(
            `${item.name}@${item.version}\t${item.status}\t${item.digest.slice(0, 19)}...`,
          );
        }
      });
    },
  );
}
