import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { idOption } from "./options";
import { restoreOptions, restoreRequest } from "./restore-request";

export function addRecreateCommand(parser: Argv) {
  return addAction(
    parser,
    "recreate",
    "Restore a workspace's latest ready checkpoint",
    (command) => restoreOptions(idOption(command)),
    async (flags) => {
      const request = restoreRequest(flags);
      const result = await controlPlaneClient().workspaces.recreate(need(flags, "id"), request, request.external_id);
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
