import type { Argv } from "yargs";
import { need } from "../../cli-context";
import { addAction } from "../command";
import { runManagedServer } from "./process";

export function addRunCommand(parser: Argv) {
  return addAction(
    parser,
    "run",
    false,
    (command) =>
      command.option("instance-token", {
        type: "string",
        demandOption: true,
        hidden: true,
      }),
    async (flags) => runManagedServer(need(flags, "instance-token")),
  );
}
