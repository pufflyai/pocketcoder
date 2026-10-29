import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { principalOutputOptions } from "./options";

export function addGetCommand(parser: Argv) {
  return addAction(
    parser,
    "get",
    "Read a principal",
    (command) =>
      principalOutputOptions(command).option("id", { type: "string", demandOption: true, description: "Principal ID" }),
    async (flags) => {
      const principal = await controlPlaneClient().principals.get(need(flags, "id"));
      console.log(JSON.stringify(principal, null, 2));
    },
  );
}
