import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addOutputsCommand(parser: Argv) {
  return addAction(
    parser,
    "outputs",
    "Read audited template-declared outputs",
    idOption,
    async (flags) => {
      console.log(
        JSON.stringify(await controlPlaneClient().outputs.list(need(flags, "id")), null, 2),
      );
    },
  );
}
