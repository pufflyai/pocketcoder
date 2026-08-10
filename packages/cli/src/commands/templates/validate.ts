import { loadTemplateFile } from "@pstdio/pocketcoder-runtime-core";
import type { Argv } from "yargs";
import { type Flags, fail } from "../../cli-context";
import { addAction } from "../command";

function templateFiles(flags: Flags) {
  return Array.isArray(flags.files) ? flags.files.map(String) : [];
}

export function addValidateCommand(parser: Argv) {
  return addAction(
    parser,
    "validate <files..>",
    "Validate template manifests offline",
    (command) =>
      command.positional("files", {
        type: "string",
        array: true,
        description: "Template manifest files",
      }),
    async (flags) => {
      const files = templateFiles(flags);
      if (files.length === 0) fail("provide at least one template file");
      let valid = true;
      for (const file of files) {
        try {
          const parsed = await loadTemplateFile(file);
          console.log(
            `${file}: ok (${parsed.manifest.metadata.name}@${parsed.manifest.spec.version}, ${parsed.digest.slice(0, 19)}...)`,
          );
        } catch (error) {
          valid = false;
          console.error(`${file}: INVALID: ${error instanceof Error ? error.message : error}`);
        }
      }
      if (!valid) process.exit(1);
    },
  );
}
