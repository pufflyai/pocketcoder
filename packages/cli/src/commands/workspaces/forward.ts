import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";
import { startPreviewForward } from "./forward-server";
import { idOption } from "./options";

export function addForwardCommand(parser: Argv) {
  return addAction(
    parser,
    "forward",
    "Forward a declared preview to loopback",
    (command) =>
      idOption(command)
        .option("name", { type: "string", demandOption: true, description: "Template preview name" })
        .option("port", { type: "number", default: 0, description: "Local port (0 selects a free port)" }),
    async (flags) => {
      const port = Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local port.");
      const preview = await controlPlaneClient().previews.open(need(flags, "id"), need(flags, "name"));
      const server = await startPreviewForward(preview.url, port);
      console.log(`http://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          void server.stop(true).then(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    },
  );
}
