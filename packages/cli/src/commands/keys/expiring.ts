import type { Argv } from "yargs";
import { controlPlaneClient } from "../../command/cli-context";
import { addAction } from "../command";

export function addExpiringCommand(parser: Argv) {
  return addAction(
    parser,
    "expiring",
    "List active keys that expire within a window, soonest first",
    (command) =>
      command.option("within-hours", { type: "number", default: 168, description: "Window in hours (7 days)" }),
    async (flags) => {
      const result = await controlPlaneClient().keys.expiring({ withinHours: Number(flags["within-hours"]) });
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
