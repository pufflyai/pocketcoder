import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { nativeStartupHooks } from "./native-startup-hooks";

const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: native-startup-profile.ts <diagnostic-output-directory>");
const directory = resolve(output);
await mkdir(directory, { recursive: true });
const binary = join(directory, "pocketcoder");
const runner = join(directory, "runner.js");
const compiler = await Bun.build({
  entrypoints: ["packages/cli/src/index.ts"],
  compile: { outfile: binary },
  format: "cjs",
  minify: true,
  plugins: [nativeStartupHooks()],
});
if (!compiler.success) throw new AggregateError(compiler.logs, "Diagnostic native compile failed");
const fixture = await Bun.build({
  entrypoints: ["scripts/native-startup-runner.ts"],
  target: "bun",
  outdir: directory,
  naming: "runner.js",
  plugins: [nativeStartupHooks()],
});
if (!fixture.success) throw new AggregateError(fixture.logs, "Diagnostic runner build failed");
const commit = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" });
const sourceCommit = (await new Response(commit.stdout).text()).trim();
if (await commit.exited) throw new Error("Cannot record diagnostic source commit");
const status = Bun.spawn(["git", "status", "--porcelain"], { stdout: "pipe" });
const sourceStatus = (await new Response(status.stdout).text()).trim();
if (await status.exited) throw new Error("Cannot record diagnostic source status");
const evidence = [];
for (const path of [
  binary,
  runner,
  "scripts/native-startup-hooks.ts",
  "scripts/native-startup-profile.ts",
  "scripts/native-startup-runner.ts",
]) {
  const bytes = await Bun.file(path).bytes();
  evidence.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await Bun.write(
  join(directory, "profile.json"),
  JSON.stringify(
    {
      qualification: "Instrumented executable. Diagnostic evidence only, not the normal candidate artifact.",
      sourceCommit,
      sourceStatus,
      compiler: Bun.version,
      platform: process.platform,
      arch: process.arch,
      evidence,
    },
    null,
    2,
  ),
);
