import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addGetCommand(parser: Argv) {
  return addAction(parser, "get", "Get checkpoint metadata", idOption, async (flags) => {
    console.log(
      JSON.stringify(await controlPlaneClient().checkpoints.get(need(flags, "id")), null, 2),
    );
  });
}
