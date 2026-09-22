import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";

export function addPurgeCommand(parser: Argv) {
  return addAction(
    parser,
    "purge",
    "Purge owned workspace content and return a durable operation",
    (command) =>
      command
        .option("id", { type: "string", demandOption: true, description: "Workspace ID" })
        .option("request-id", {
          type: "string",
          demandOption: true,
          description: "Stable request ID; use a new ID for backup replay",
        })
        .option("principal-id", { type: "string", description: "Explicit target for delegated operator recovery" }),
    async (flags) => {
      const client = controlPlaneClient();
      const id = need(flags, "id");
      const key = need(flags, "request-id");
      const result =
        typeof flags["principal-id"] === "string"
          ? await client.recovery.purge(flags["principal-id"], id, key)
          : await client.workspaces.purge(id, key);
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
