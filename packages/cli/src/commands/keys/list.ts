import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";

export function addListCommand(parser: Argv) {
  return addAction(
    parser,
    "list",
    "List authoritative key metadata through the public API",
    (command) =>
      command
        .option("principal-id", { type: "string", demandOption: true })
        .option("request-id", { type: "string", description: "Reconcile an issuance request" })
        .option("cursor", { type: "string" })
        .option("limit", { type: "number", default: 50 }),
    async (flags) => {
      const result = await controlPlaneClient().keys.list(need(flags, "principal-id"), {
        limit: Number(flags.limit),
        ...(typeof flags.cursor === "string" ? { cursor: flags.cursor } : {}),
        ...(typeof flags["request-id"] === "string" ? { requestId: flags["request-id"] } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    },
  );
}
