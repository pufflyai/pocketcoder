import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { pagination, paginationOptions } from "./options";

export function addTerminalSessionsCommand(parser: Argv) {
  return addAction(
    parser,
    "terminal-sessions",
    "Read audited terminal sessions",
    paginationOptions,
    async (flags) => {
      const result = await controlPlaneClient().terminals.list(
        need(flags, "id"),
        pagination(flags),
      );
      for (const session of result.items) console.log(JSON.stringify(session));
      if (result.items.length === 0) console.log("(no terminal sessions)");
      if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
    },
  );
}
