import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { pagination, paginationOptions } from "./options";

export function addLogsCommand(parser: Argv) {
  return addAction(parser, "logs", "Read workspace logs", paginationOptions, async (flags) => {
    const result = await controlPlaneClient().logs.list(need(flags, "id"), pagination(flags));
    for (const line of result.items) {
      process.stdout.write(`[${line.stream} #${line.seq}] ${line.content}`);
      if (!line.content.endsWith("\n")) process.stdout.write("\n");
    }
    if (result.items.length === 0) console.log("(no logs)");
    if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
  });
}
