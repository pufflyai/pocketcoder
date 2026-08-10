import { isCheckpointState } from "@pstdio/pocketcoder-contracts";
import type { Argv } from "yargs";
import { controlPlaneClient, fail, need } from "../../cli-context";
import { addAction } from "../command";

export function addListCommand(parser: Argv) {
  return addAction(
    parser,
    "list",
    "List checkpoints for a workspace",
    (command) =>
      command
        .option("workspace", { type: "string", demandOption: true })
        .option("state", { type: "string" })
        .option("json", { type: "boolean" }),
    async (flags) => {
      const state = typeof flags.state === "string" ? flags.state : undefined;
      const checkpointState = state && isCheckpointState(state) ? state : undefined;
      if (state && !checkpointState) fail(`unknown checkpoint state: ${state}`);
      const result = await controlPlaneClient().checkpoints.list(need(flags, "workspace"), {
        ...(checkpointState ? { state: checkpointState } : {}),
      });
      if (flags.json) console.log(JSON.stringify(result.items, null, 2));
      else for (const item of result.items) console.log(JSON.stringify(item));
      if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
    },
  );
}
