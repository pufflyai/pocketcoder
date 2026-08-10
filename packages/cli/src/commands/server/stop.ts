import type { Argv } from "yargs";
import { addAction } from "../command";
import { stopManagedServer } from "./process";

export function addStopCommand(parser: Argv) {
  return addAction(
    parser,
    "stop",
    "Gracefully stop the managed PocketCoder server",
    (command) =>
      command.option("timeout-seconds", {
        type: "number",
        default: 15,
        description: "Maximum time to wait for graceful shutdown",
      }),
    async (flags) => {
      await stopManagedServer({ timeoutSeconds: flags["timeout-seconds"] as number });
    },
  );
}
