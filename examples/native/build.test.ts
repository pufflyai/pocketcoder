import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../e2e/local-process";

test("the Linux executable including its database assets fits the 90 MB budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-size-"));
  const binary = join(directory, "pocketcoder");
  const root = resolve(import.meta.dir, "../..");
  try {
    await command(
      [
        process.execPath,
        "build",
        join(root, "packages/cli/src/index.ts"),
        "--compile",
        "--minify",
        "--target",
        "bun-linux-x64",
        "--outfile",
        binary,
      ],
      { quiet: true },
    );
    expect((await stat(binary)).size).toBeLessThanOrEqual(90_000_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
