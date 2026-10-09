import type { Argv } from "yargs";
import { addAction } from "./command";

export function addServeCommand(parser: Argv) {
  return addAction(
    parser,
    "serve",
    "Start the server with one private data folder",
    (command) =>
      command
        .option("dir", { type: "string", description: "Data folder (default: ./pc_data)" })
        .option("http", { type: "string", description: "Operator bind address (default: 127.0.0.1:8090)" })
        .option("driver", {
          choices: ["docker", "kubernetes"] as const,
          description: "Workspace driver (default: docker)",
        }),
    async (flags) => {
      const [{ loadConfig }, { runPocketCoderServerUntilSignal }] = await Promise.all([
        import("@pstdio/pocketcoder-server/config"),
        import("@pstdio/pocketcoder-server/lifecycle"),
      ]);
      const env = { ...process.env };
      delete env.POCKETCODER_AUTH_PEPPER;
      delete env.POCKETCODER_EVENT_SIGNING_KEY;
      if (typeof flags.dir === "string") env.POCKETCODER_DIR = flags.dir;
      if (typeof flags.http === "string") env.POCKETCODER_HTTP = flags.http;
      if (typeof flags.driver === "string") env.POCKETCODER_DRIVER = flags.driver;
      await runPocketCoderServerUntilSignal(loadConfig(env));
    },
  );
}
