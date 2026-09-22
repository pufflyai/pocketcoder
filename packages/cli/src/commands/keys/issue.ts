import { randomUUID } from "node:crypto";
import { issuePrincipalKey } from "@pstdio/pocketcoder-runtime-core";
import type { Argv } from "yargs";
import { controlPlaneClient, fail, need, valueList, withStore } from "../../command/cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";

export function addIssueCommand(parser: Argv) {
  return addAction(
    parser,
    "issue",
    "Issue or reconcile a machine key",
    (command) =>
      command
        .option("principal", { type: "string", description: "Principal name for local operator bootstrap" })
        .option("principal-id", { type: "string", description: "Target principal ID through the public API" })
        .option("request-id", {
          type: "string",
          description: "Persist this identity before issuance to reconcile a lost response",
        })
        .option("scopes", { type: "string", description: "Comma-separated restricted scopes" })
        .option("expires", {
          type: "string",
          default: "never",
          description: "ISO 8601 expiry; never is local operator only",
        })
        .option("manage-principals", {
          type: "string",
          description: "Explicit target UUIDs for local operator bootstrap",
        })
        .option("json", {
          type: "boolean",
          default: false,
          description: "Print key metadata and one-time token as JSON",
        })
        .conflicts("principal", "principal-id")
        .implies("principal-id", "request-id")
        .check((flags) => {
          if (!flags.principal && !flags["principal-id"])
            throw new Error("Missing required argument: principal or principal-id");
          return true;
        }),
    async (flags) => {
      const expires = need(flags, "expires");
      const expiresAt = expires === "never" ? null : expires;
      const scopes = typeof flags.scopes === "string" ? parseScopes(flags.scopes) : [];
      const requestId = typeof flags["request-id"] === "string" ? flags["request-id"] : randomUUID();
      if (typeof flags["principal-id"] === "string") {
        if (!expiresAt) fail("public key issuance requires --expires <ISO8601>");
        if (flags["manage-principals"]) fail("delegated grants require local operator bootstrap");
        const result = await controlPlaneClient().keys.issue(flags["principal-id"], {
          request_id: requestId,
          scopes,
          expires_at: expiresAt,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const pepper = process.env.POCKETCODER_AUTH_PEPPER;
      if (!pepper) fail("POCKETCODER_AUTH_PEPPER is required to issue keys locally");
      await withStore(async (store) => {
        const name = need(flags, "principal");
        const principal = await store.getPrincipalByName(name);
        if (!principal) fail(`unknown principal: ${name}`);
        const managedPrincipalIds =
          typeof flags["manage-principals"] === "string" ? valueList(flags["manage-principals"]) : [];
        for (const id of managedPrincipalIds) {
          if (!/^[0-9a-f-]{36}$/i.test(id) || !(await store.getPrincipal(id))) fail("unknown managed principal ID");
        }
        const result = await issuePrincipalKey(
          store,
          pepper,
          principal,
          { request_id: requestId, scopes, expires_at: expiresAt },
          { managedPrincipalIds, operatorBootstrap: true },
        );
        if (flags.json || !result.token) console.log(JSON.stringify({ key: result.key, token: result.token }, null, 2));
        else {
          console.log(`machine key (shown once; request ${requestId}):`);
          console.log(result.token);
        }
      });
    },
  );
}
