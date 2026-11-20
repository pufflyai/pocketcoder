import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Extension packages run outside this monorepo. Inline private workspace code and
// ship only the host SDK as an external dependency.
export async function prepareExtension(out: string) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "extension.ts")],
    target: "bun",
    format: "esm",
    outdir: out,
    external: ["@pstdio/sdk", "@pstdio/sdk/*"],
    naming: "extension.js",
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle Remote Testing");
  const manifest = await Bun.file(join(import.meta.dir, "package.json")).json();
  const { devDependencies: _dev, scripts: _scripts, ...published } = manifest;
  await Bun.write(join(out, "package.json"), `${JSON.stringify({ ...published, main: "./extension.js" }, null, 2)}\n`);
  await cp(join(import.meta.dir, "skills"), join(out, "skills"), { recursive: true });
  await cp(join(import.meta.dir, "README.md"), join(out, "README.md"));
}
if (import.meta.main) await prepareExtension(join(import.meta.dir, "dist"));
