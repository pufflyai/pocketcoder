import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { idOption } from "./options";

export function addPreviewCommand(parser: Argv) {
  return addAction(
    parser,
    "preview",
    "Open a declared workspace webapp",
    (command) =>
      idOption(command)
        .option("name", { type: "string", demandOption: true, description: "Template preview name" })
        .option("open", { type: "boolean", description: "Open the URL in the default browser" }),
    async (flags) => {
      const preview = await controlPlaneClient().previews.open(need(flags, "id"), need(flags, "name"));
      console.log(preview.url);
      if (flags.open) {
        const executable = process.platform === "darwin" ? "open" : "xdg-open";
        const process_ = Bun.spawn([executable, preview.url], { stdout: "ignore", stderr: "inherit" });
        if ((await process_.exited) !== 0) throw new Error("Could not open the preview URL.");
      }
    },
  );
}
