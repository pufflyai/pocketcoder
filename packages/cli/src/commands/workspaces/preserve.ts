import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";

export function addPreserveCommand(parser: Argv) {
  return addAction(
    parser,
    "preserve",
    "Stop and checkpoint a persistence-enabled workspace",
    (command) =>
      command
        .option("id", { type: "string", demandOption: true, description: "Workspace ID" })
        .option("retention", { type: "string" })
        .option("label", { type: "string" }),
    async (flags) => {
      const id = need(flags, "id");
      const result = await controlPlaneClient().workspaces.preserve(
        id,
        {
          ...(typeof flags.retention === "string" ? { retention: flags.retention } : {}),
          ...(typeof flags.label === "string" ? { label: flags.label } : {}),
        },
        `preserve-${id}-${randomUUID()}`,
      );
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
