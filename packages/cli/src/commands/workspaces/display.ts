import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addDisplayCommand(parser: Argv) {
  return addAction(
    parser,
    "display",
    "Open the workspace desktop",
    (command) =>
      idOption(command)
        .option("control", {
          type: "boolean",
          default: false,
          description: "Request authorized keyboard and pointer control",
        })
        .option("open", { type: "boolean", description: "Open the display in the default browser" }),
    async (flags) => {
      const display = await controlPlaneClient().displays.open(need(flags, "id"), flags.control === true);
      console.log(display.url);
      if (flags.open) {
        const executable = process.platform === "darwin" ? "open" : "xdg-open";
        const child = Bun.spawn([executable, display.url], { stdout: "ignore", stderr: "inherit" });
        if ((await child.exited) !== 0) throw new Error("Could not open the display URL.");
      }
    },
  );
}
