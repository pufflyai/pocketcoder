import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { restoreOptions, restoreRequest } from "./restore-request";

export function addRestoreCommand(parser: Argv) {
  return addAction(
    parser,
    "restore",
    "Restore a checkpoint into a new workspace execution",
    (command) => restoreOptions(command.option("checkpoint", { type: "string", demandOption: true })),
    async (flags) => {
      const request = restoreRequest(flags);
      const result = await controlPlaneClient().checkpoints.restore(
        need(flags, "checkpoint"),
        request,
        request.external_id,
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
