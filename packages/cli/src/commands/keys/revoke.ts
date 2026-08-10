import type { Argv } from "yargs";
import { need, withStore } from "../../cli-context";
import { addAction } from "../command";

export function addRevokeCommand(parser: Argv) {
  return addAction(
    parser,
    "revoke",
    "Revoke a machine key",
    (command) =>
      command.option("id", {
        type: "string",
        demandOption: true,
        description: "Machine key ID",
      }),
    async (flags) => {
      await withStore(async (store) => {
        const id = need(flags, "id");
        const revoked = await store.revokeMachineKey(id, new Date());
        console.log(revoked ? `revoked ${id}` : `key ${id} not found or already revoked`);
      });
    },
  );
}
