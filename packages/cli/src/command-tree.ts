import yargs, { type Argv } from "yargs";
// Bundled into dist at build time so the binary reports its own version without reading the filesystem.
import { version } from "../package.json" with { type: "json" };
import { addCommands } from "./commands";

export function createCli(argv: string[]): Argv {
  const root = yargs(argv)
    .scriptName("pcd")
    .usage("$0 <command>")
    .parserConfiguration({ "camel-case-expansion": false })
    .option("workdir", {
      type: "string",
      description: "PocketCoder project directory used for .env discovery",
    })
    .option("env-file", {
      type: "string",
      description: "Explicit environment file, relative to --workdir",
    })
    .help()
    .alias("help", "h")
    .version(version)
    .recommendCommands()
    .showHelpOnFail(true)
    .epilogue(
      [
        "Environment:",
        "  POCKETCODER_DATABASE_URL, POCKETCODER_DATABASE_SCHEMA (db/key/template commands)",
        "  POCKETCODER_URL, POCKETCODER_KEY (workspace and doctor commands)",
        "  POCKETCODER_AUTH_PEPPER (key issuance)",
        "  POCKETCODER_STATE_DIR (managed server state and message cursors)",
        "  Reads the nearest .env; exported values take precedence",
      ].join("\n"),
    );
  return addCommands(root).demandCommand(1, "A command is required.").strict();
}
