import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../cli-context";
import { addAction } from "../command";
import { pagination, paginationOptions } from "./options";

export function addNetworkEventsCommand(parser: Argv) {
  return addAction(
    parser,
    "network-events",
    "Read durable workspace egress decisions",
    paginationOptions,
    async (flags) => {
      const result = await controlPlaneClient().networkEvents.list(
        need(flags, "id"),
        pagination(flags),
      );
      for (const event of result.items) console.log(JSON.stringify(event));
      if (result.items.length === 0) console.log("(no network events)");
      if (result.nextCursor) console.log(`next cursor: ${result.nextCursor}`);
    },
  );
}
