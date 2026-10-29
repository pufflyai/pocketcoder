import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";

export function addRotateCommand(parser: Argv) {
  return addAction(
    parser,
    "rotate",
    "Issue a successor with the same grants; the rotated key stays valid until revoked",
    (command) =>
      command
        .option("principal-id", { type: "string", demandOption: true, description: "Target principal ID" })
        .option("id", { type: "string", demandOption: true, description: "Key ID to rotate" })
        .option("request-id", {
          type: "string",
          demandOption: true,
          description: "Persist this identity before rotation to reconcile a lost response",
        })
        .option("expires", {
          type: "string",
          description: "ISO 8601 expiry; omitted keeps the old lifetime, capped at the calling key's expiry",
        })
        .option("json", {
          type: "boolean",
          default: false,
          description: "Print key metadata and one-time token as JSON",
        }),
    async (flags) => {
      const result = await controlPlaneClient().keys.rotate(need(flags, "principal-id"), need(flags, "id"), {
        request_id: need(flags, "request-id"),
        ...(typeof flags.expires === "string" ? { expires_at: flags.expires } : {}),
      });
      if (flags.json || !result.token) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`successor key (shown once; expires ${result.key.expires_at}; id ${result.key.id}):`);
        console.log(result.token);
      }
    },
  );
}
