import { admissionMap, readPrincipalFile } from "@pstdio/pocketcoder-server/principal-file";
import type { Argv } from "yargs";
import { need } from "../../command/cli-context";
import { addAction } from "../command";

// Principal IDs derive from names, so the map needs only the file, never a running controller.
export function addAdmissionMapCommand(parser: Argv) {
  return addAction(
    parser,
    "admission-map",
    "Print the principal to admission template map from a principal file",
    (command) => command.option("file", { type: "string", demandOption: true, description: "Principal file" }),
    async (flags) => {
      console.log(JSON.stringify(admissionMap(await readPrincipalFile(need(flags, "file"))), null, 2));
    },
  );
}
