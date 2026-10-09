import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadTemplateFile } from "@pstdio/pocketcoder-runtime-core";
import type { Argv } from "yargs";
import { controlPlaneClient, need } from "../../command/cli-context";
import { addAction } from "../command";

export function addImportCommand(parser: Argv) {
  return addAction(
    parser,
    "import <dir>",
    "Publish immutable template versions through the API",
    (command) =>
      command.positional("dir", {
        type: "string",
        demandOption: true,
        description: "Directory of JSON or YAML template manifests",
      }),
    async (flags) => {
      const directory = need(flags, "dir");
      const files = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && /\.(json|ya?ml)$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      if (!files.length) throw new Error("No JSON or YAML template manifests found.");
      // Validate the whole directory before publishing any version.
      const manifests = await Promise.all(files.map((file) => loadTemplateFile(join(directory, file))));
      const client = controlPlaneClient();
      for (const parsed of manifests) {
        const item = await client.templates.publish(parsed.manifest);
        console.log(`${item.name}@${item.version}\t${item.status}\t${item.digest}`);
      }
    },
  );
}
