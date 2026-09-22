import type { Argv } from "yargs";
import { controlPlaneClient, need, withStore } from "../../command/cli-context";
import { addAction } from "../command";

export function addRevokeCommand(parser: Argv) {
  return addAction(
    parser,
    "revoke",
    "Revoke a machine key",
    (command) =>
      command
        .option("principal-id", { type: "string", description: "Target principal ID through the public API" })
        .option("id", {
          type: "string",
          demandOption: true,
          description: "Machine key ID",
        }),
    async (flags) => {
      if (typeof flags["principal-id"] === "string") {
        console.log(
          JSON.stringify(await controlPlaneClient().keys.revoke(flags["principal-id"], need(flags, "id")), null, 2),
        );
        return;
      }
      await withStore(async (store) => {
        const id = need(flags, "id");
        const revoked = await store.revokeMachineKey(id, new Date());
        console.log(revoked ? `revoked ${id}` : `key ${id} not found or already revoked`);
      });
    },
  );
}
