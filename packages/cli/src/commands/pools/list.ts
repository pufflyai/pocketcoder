import type { Argv } from "yargs";
import { controlPlaneClient } from "../../cli-context";
import { addAction } from "../command";

export function addListCommand(parser: Argv) {
  return addAction(
    parser,
    "list",
    "List warm pool inventory and metrics",
    (command) => command.option("json", { type: "boolean", description: "Print JSON" }),
    async (flags) => {
      const body = await controlPlaneClient().administration.warmPools();
      if (flags.json) console.log(JSON.stringify(body, null, 2));
      else {
        for (const item of body.items) {
          const counts = Object.entries(item.counts)
            .map(([state, count]) => `${state}=${count}`)
            .join(" ");
          console.log(
            `${item.template}@${item.version}\tdesired=${item.desired}\t${counts || "empty"}\toldest_ready_ms=${item.oldest_ready_age_ms ?? "-"}`,
          );
        }
        console.log(
          `metrics\t${Object.entries(body.metrics)
            .map(([name, value]) => `${name}=${value}`)
            .join(" ")}`,
        );
      }
    },
  );
}
