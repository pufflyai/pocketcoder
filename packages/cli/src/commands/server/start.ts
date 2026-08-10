import type { Argv } from "yargs";
import { addAction } from "../command";
import { startManagedServer } from "./process";

export function addStartCommand(parser: Argv) {
  return addAction(
    parser,
    "start",
    "Start the configured PocketCoder server",
    (command) =>
      command
        .option("foreground", {
          type: "boolean",
          description: "Run attached until SIGINT or SIGTERM",
        })
        .option("timeout-seconds", {
          type: "number",
          default: 30,
          description: "Maximum time to wait for server health",
        }),
    async (flags) => {
      await startManagedServer({
        foreground: flags.foreground === true,
        timeoutSeconds: flags["timeout-seconds"] as number,
      });
    },
  );
}
