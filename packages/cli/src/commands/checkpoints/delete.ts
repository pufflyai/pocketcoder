import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addDeleteCommand(parser: Argv) {
  return addAction(
    parser,
    "delete",
    "Delete checkpoint content and metadata asynchronously",
    idOption,
    async (flags) => {
      const id = need(flags, "id");
      console.log(
        JSON.stringify(await controlPlaneClient().checkpoints.delete(id, `delete-${id}`), null, 2),
      );
    },
  );
}
