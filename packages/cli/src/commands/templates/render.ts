import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { loadTemplateSource } from "@pstdio/pocketcoder-runtime-core";
import type { Argv } from "yargs";
import { type Flags, need } from "../../cli-context";
import { addAction } from "../command";

export function addRenderCommand(parser: Argv) {
  return addAction(
    parser,
    "render <manifest>",
    "Render one deployable immutable template",
    (command) =>
      command
        .positional("manifest", {
          type: "string",
          demandOption: true,
          description: "Source JSON or YAML template",
        })
        .option("image", {
          type: "string",
          description: "Digest-pinned image reference",
        })
        .option("set", {
          type: "string",
          array: true,
          description: "Typed JSON-Pointer override (repeatable)",
        })
        .option("out", {
          type: "string",
          demandOption: true,
          description: "Output directory",
        }),
    renderTemplateFile,
  );
}

async function renderTemplateFile(flags: Flags) {
  const sourcePath = resolve(need(flags, "manifest"));
  const outputDirectory = resolve(need(flags, "out"));
  const set = Array.isArray(flags.set)
    ? flags.set.map(String)
    : typeof flags.set === "string"
      ? [flags.set]
      : [];
  const rendered = renderTemplateManifest(await loadTemplateSource(sourcePath), {
    ...(typeof flags.image === "string" ? { image: flags.image } : {}),
    set,
  });
  const outputPath = join(outputDirectory, `${rendered.manifest.metadata.name}.json`);
  if (sourcePath === outputPath)
    throw new Error("render output must not overwrite the source file");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, `${rendered.canonical}\n`, "utf8");
  console.log(
    `wrote ${outputPath} (${rendered.manifest.metadata.name}@${rendered.manifest.spec.version})`,
  );
}
