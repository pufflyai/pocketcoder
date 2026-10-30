import type { RestoreRequest } from "@pstdio/pocketcoder-contracts";
import type { Argv } from "yargs";
import { type Flags, fail, need } from "../../command/cli-context";
import { parseLaunchInput } from "./launch-input";

// Shared by restore, recreate and resume, which all send the same request body.
export function restoreOptions(command: Argv) {
  return command
    .option("external-id", { type: "string", demandOption: true })
    .option("input", { type: "string", description: "Launch input as a JSON object" })
    .option("template-version", {
      type: "string",
      description: "Run another compatible version of the checkpoint's template",
    });
}

export function restoreRequest(flags: Flags): RestoreRequest {
  const launchInput = parseLaunchInput(flags.input, fail);
  const templateVersion = flags["template-version"];
  return {
    external_id: need(flags, "external-id"),
    ...(launchInput ? { launch_input: launchInput } : {}),
    ...(typeof templateVersion === "string" ? { template_version: templateVersion } : {}),
  };
}
