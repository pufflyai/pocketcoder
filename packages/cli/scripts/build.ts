import { rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
await rm(join(root, "dist"), { recursive: true, force: true });
const launcher = await Bun.build({
  entrypoints: [join(root, "src/bin.ts")],
  outdir: join(root, "dist"),
  target: "node",
});
if (!launcher.success) throw new AggregateError(launcher.logs, "CLI launcher build failed");
for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
  const executable = join(root, "dist/native", target, "pocketcoder");
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      join(root, "src/index.ts"),
      "--compile",
      "--minify",
      "--format=cjs",
      `--target=bun-${target}`,
      "--outfile",
      executable,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await child.exited) !== 0) throw new Error(`Native CLI build failed: ${target}`);
  if ((await stat(executable)).size > 90_000_000) throw new Error(`Executable exceeded 90 MB: ${target}`);
}
