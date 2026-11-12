import type { Argv } from "yargs";
import { requestLocalAdministration } from "../../command/local-admin";
import { addAction } from "../command";

export function addPlanCommand(parser: Argv) {
  const commands = addAction(
    parser,
    "plan",
    "Show what the controller's principal file would change on the next reconcile, without changing anything",
    (command) => command.option("dir", { type: "string", description: "Data folder of the running server" }),
    async (flags) => {
      console.log(JSON.stringify(await requestLocalAdministration(flags, "/v1/principals/plan"), null, 2));
    },
  );
  return addAction(
    commands,
    "reconcile",
    "Apply the mounted principals file now",
    (command) => command.option("dir", { type: "string", description: "Data folder of the running server" }),
    async (flags) => {
      console.log(JSON.stringify(await requestLocalAdministration(flags, "/v1/principals/reconcile", {}), null, 2));
    },
  );
}
