import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import type { Argv } from "yargs";
import { fail, need, withStore } from "../../cli-context";
import { addAction } from "../command";
import { parseScopes } from "../scopes";

export function addIssueCommand(parser: Argv) {
  return addAction(
    parser,
    "issue",
    "Issue a machine key",
    (command) =>
      command
        .option("principal", {
          type: "string",
          demandOption: true,
          description: "Principal name",
        })
        .option("scopes", {
          type: "string",
          description: "Comma-separated scopes; defaults to the principal scopes",
        })
        .option("expires", {
          type: "string",
          default: "never",
          description: "Expiration as ISO 8601, or never",
        }),
    async (flags) => {
      const pepper = process.env.POCKETCODER_AUTH_PEPPER;
      if (!pepper) fail("POCKETCODER_AUTH_PEPPER is required to issue keys");
      await withStore(async (store) => {
        const name = need(flags, "principal");
        const principal = await store.getPrincipalByName(name);
        if (!principal) fail(`unknown principal: ${name}`);
        const expiresRaw = typeof flags.expires === "string" ? flags.expires : "never";
        const expiresAt = expiresRaw === "never" ? null : new Date(expiresRaw);
        if (expiresAt && Number.isNaN(expiresAt.getTime())) {
          fail(`invalid --expires value: ${expiresRaw}`);
        }
        const key = issueMachineKey(pepper);
        await store.insertMachineKey({
          id: key.id,
          principalId: principal.id,
          secretDigest: key.secretDigest,
          scopes: typeof flags.scopes === "string" ? parseScopes(flags.scopes) : [],
          createdAt: new Date(),
          expiresAt,
          revokedAt: null,
          lastUsedAt: null,
        });
        console.log("machine key (shown once, store it now):");
        console.log(key.token);
      });
    },
  );
}
