import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderTemplateManifest } from "@pstdio/pocketcoder-contracts";
import { loadTemplateSource } from "@pstdio/pocketcoder-runtime-core";
import { type Flags, need } from "./cli-context";

export async function renderTemplateFile(flags: Flags) {
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
