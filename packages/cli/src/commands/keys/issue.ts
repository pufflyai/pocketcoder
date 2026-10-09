import type { Argv } from "yargs";
import { controlPlaneClient, need, valueList } from "../../command/cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";

export function addIssueCommand(parser: Argv) {
  return addAction(
    parser,
    "issue",
    "Issue or reconcile a machine key through the server",
    (command) =>
      command
        .option("principal-id", { type: "string", demandOption: true, description: "Target principal ID" })
        .option("request-id", {
          type: "string",
          demandOption: true,
          description: "Persist this identity before issuance to reconcile a lost response",
        })
        .option("scopes", { type: "string", demandOption: true, description: "Comma-separated restricted scopes" })
        .option("templates", {
          type: "string",
          description: "Comma-separated template grants; omitted uses target grants",
        })
        .option("expires", {
          type: "string",
          demandOption: true,
          description: "ISO 8601 expiry within the calling key's lifetime",
        })
        .option("manage-principals", {
          type: "string",
          description: "Exact recovery target UUIDs; requires an explicit admin key",
        })
        .option("json", {
          type: "boolean",
          default: false,
          description: "Print key metadata and one-time token as JSON",
        }),
    async (flags) => {
      const result = await controlPlaneClient().keys.issue(need(flags, "principal-id"), {
        request_id: need(flags, "request-id"),
        scopes: parseScopes(need(flags, "scopes")),
        expires_at: need(flags, "expires"),
        ...(typeof flags.templates === "string" ? { templates: valueList(flags.templates) } : {}),
        ...(typeof flags["manage-principals"] === "string"
          ? { managed_principal_ids: valueList(flags["manage-principals"]) }
          : {}),
      });
      if (flags.json || !result.token) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`machine key (shown once; request ${result.key.issuance_request_id}):`);
        console.log(result.token);
      }
    },
  );
}
