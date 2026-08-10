import type { Argv } from "yargs";
import { controlPlaneClient, fail, need } from "../../cli-context";
import { addAction } from "../command";
import { parseLaunchInput } from "./launch-input";

export function addRestoreCommand(parser: Argv) {
  return addAction(
    parser,
    "restore",
    "Restore a checkpoint into a new workspace execution",
    (command) =>
      command
        .option("checkpoint", { type: "string", demandOption: true })
        .option("external-id", { type: "string", demandOption: true })
        .option("input", { type: "string", description: "Launch input as a JSON object" }),
    async (flags) => {
      const externalId = need(flags, "external-id");
      const launchInput = parseLaunchInput(flags.input, fail);
      const result = await controlPlaneClient().checkpoints.restore(
        need(flags, "checkpoint"),
        { external_id: externalId, ...(launchInput ? { launch_input: launchInput } : {}) },
        externalId,
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
