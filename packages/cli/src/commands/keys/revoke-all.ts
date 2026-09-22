import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";

export function addRevokeAllCommand(parser: Argv) {
  return addAction(
    parser,
    "revoke-all",
    "Disable a principal and revoke every key atomically",
    (command) => command.option("principal-id", { type: "string", demandOption: true }),
    async (flags) => {
      console.log(JSON.stringify(await controlPlaneClient().keys.revokeAll(need(flags, "principal-id")), null, 2));
    },
  );
}
