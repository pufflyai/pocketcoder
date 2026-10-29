import type { Argv } from "yargs";
import { requestLocalAdministration } from "../../command/local-admin";
import { addAction } from "../command";

export function addPlanCommand(parser: Argv) {
  return addAction(
    parser,
    "plan",
    "Show what the controller's principal file would change on the next start, without changing anything",
    (command) => command.option("dir", { type: "string", description: "Data folder of the running server" }),
    async (flags) => {
      console.log(JSON.stringify(await requestLocalAdministration(flags, "/v1/principals/plan"), null, 2));
    },
  );
}
