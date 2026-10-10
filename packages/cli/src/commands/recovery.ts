import type { Argv } from "yargs";
import { requestLocalAdministration } from "../command/local-admin";
import { addAction, addResource } from "./command";

const dir = (command: Argv) =>
  command.option("dir", { type: "string", description: "Data folder of the controller in recovery" });

export function addRecoveryCommands(parser: Argv) {
  return addResource(parser, "recovery", "Finish restoring a controller from a backup", (commands) => {
    addAction(commands, "status", "Show the recovery state of a restored controller", dir, async (flags) => {
      console.log(JSON.stringify(await requestLocalAdministration(flags, "/v1/recovery"), null, 2));
    });
    return addAction(
      commands,
      "complete",
      "Replay the deletion journal, fence old runtimes and grants, and allow service",
      dir,
      async (flags) => {
        // Purges and runtime removal can take a while; the controller owns their limits.
        const result = await requestLocalAdministration(flags, "/v1/recovery/complete", {}, null);
        console.log(JSON.stringify(result, null, 2));
      },
    );
  });
}
