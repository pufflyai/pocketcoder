import { randomUUID } from "node:crypto";
import type { Argv } from "yargs";
import { need } from "../../command/cli-context";
import { requestLocalKey } from "../../command/local-admin";
import { addAction, addResource } from "../command";

export function addSuperuserCommands(parser: Argv) {
  return addResource(parser, "superuser", "Manage owner keys through the private admin socket", (commands) =>
    addAction(
      commands,
      "create",
      "Create an owner key shown once (default expiry: 24 hours)",
      (command) =>
        command
          .option("name", { choices: ["owner"] as const, default: "owner", description: "Owner principal name" })
          .option("dir", { type: "string", description: "Data folder of the running server" })
          .option("expires", { type: "string", description: "ISO 8601 expiry; required for automation" })
          .option("automation", { type: "boolean", default: false, description: "Require explicit expiry" })
          .option("request-id", {
            type: "string",
            description: "Saved operation identity for reconciling a lost response",
          })
          .option("replace", { type: "boolean", default: false, description: "Revoke this owner's earlier keys" })
          .option("json", { type: "boolean", default: false, description: "Print metadata and one-time key as JSON" }),
      async (flags) => {
        const result = await requestLocalKey(flags, "/v1/owner", {
          name: need(flags, "name"),
          request_id: flags["request-id"] ?? randomUUID(),
          expires_at: flags.expires,
          automation: flags.automation,
          replace: flags.replace,
        });
        if (flags.json || !result.token) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(
            `Owner key (shown once; expires ${result.key.expires_at}; request ${result.key.issuance_request_id}):`,
          );
          console.log(result.token);
        }
      },
    ),
  );
}
