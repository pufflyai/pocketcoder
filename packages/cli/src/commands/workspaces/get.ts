import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addGetCommand(parser: Argv) {
  return addAction(parser, "get", "Get a workspace", idOption, async (flags) => {
    console.log(
      JSON.stringify(await controlPlaneClient().workspaces.get(need(flags, "id")), null, 2),
    );
  });
}
