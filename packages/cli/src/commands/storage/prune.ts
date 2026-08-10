import type { Argv } from "yargs";
import { controlPlaneClient } from "../../cli-context";
import { addAction, unchanged } from "../command";

export function addPruneCommand(parser: Argv) {
  return addAction(
    parser,
    "prune",
    "Delete checkpoints whose retention has expired",
    unchanged,
    async () => {
      console.log(
        JSON.stringify(await controlPlaneClient().administration.pruneStorage(), null, 2),
      );
    },
  );
}
