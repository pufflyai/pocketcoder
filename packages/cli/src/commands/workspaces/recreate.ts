import type { Argv } from "yargs";
import { controlPlaneClient, fail, need } from "../../cli-context";
import { addAction } from "../command";
import { parseLaunchInput } from "./launch-input";

export function addRecreateCommand(parser: Argv) {
  return addAction(
    parser,
    "recreate",
    "Restore a workspace's latest ready checkpoint",
    (command) =>
      command
        .option("id", { type: "string", demandOption: true, description: "Workspace ID" })
        .option("external-id", { type: "string", demandOption: true })
        .option("input", { type: "string", description: "Launch input as a JSON object" }),
    async (flags) => {
      const externalId = need(flags, "external-id");
      const launchInput = parseLaunchInput(flags.input, fail);
      const result = await controlPlaneClient().workspaces.recreate(
        need(flags, "id"),
        { external_id: externalId, ...(launchInput ? { launch_input: launchInput } : {}) },
        externalId,
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
