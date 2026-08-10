import type { Argv } from "yargs";
import { addAction } from "../command";
import { printManagedServerStatus } from "./process";

export function addStatusCommand(parser: Argv) {
  return addAction(
    parser,
    "status",
    "Show managed server process and health",
    (command) => command.option("json", { type: "boolean", description: "Print JSON" }),
    async (flags) => printManagedServerStatus(flags.json === true),
  );
}
