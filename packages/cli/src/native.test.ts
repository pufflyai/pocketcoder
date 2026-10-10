import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../package.json";

test("the package launcher runs the native CLI on Node without Bun in PATH", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-cli-launcher-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "bin.ts")],
      outdir: directory,
      target: "node",
    });
    expect(build.success).toBe(true);
    const binary = join(directory, "native", `${process.platform}-${process.arch}`, "pocketcoder");
    const compile = Bun.spawn(
      [
        process.execPath,
        "build",
        join(import.meta.dir, "index.ts"),
        "--compile",
        "--minify",
        "--format=cjs",
        "--outfile",
        binary,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    expect(await compile.exited).toBe(0);
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required for the package launcher check");
    const child = Bun.spawn([node, join(directory, "bin.js"), "--version"], {
      cwd: directory,
      env: { PATH: "", HOME: directory },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    expect(output.trim()).toBe(manifest.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
