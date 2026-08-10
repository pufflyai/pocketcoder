import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addCancelCommand(parser: Argv) {
  return addAction(parser, "cancel", "Cancel a workspace", idOption, async (flags) => {
    console.log(
      JSON.stringify(await controlPlaneClient().workspaces.cancel(need(flags, "id")), null, 2),
    );
  });
}
