import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function prepareLabSdk(sdk: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), ".lab-sdk-"));
  try {
    await cp(join(sdk, "dist"), join(stage, "dist"), { recursive: true });
    const built = await Bun.build({
      entrypoints: [join(sdk, "dist/index.js")],
      target: "bun",
      outdir: join(stage, "dist"),
      naming: "index.js",
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const { name, version, type, exports } = await Bun.file(join(sdk, "package.json")).json();
    await writeFile(join(stage, "package.json"), JSON.stringify({ name, version, type, exports }));
    // The host can copy this module without resolving workspace links or its dependencies.
    await rm(target, { recursive: true, force: true });
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const repo = resolve(import.meta.dir, "../../..");
  await prepareLabSdk(join(repo, "packages/sdk"), join(import.meta.dir, "node_modules/@pstdio/pocketcoder-sdk"));
}
