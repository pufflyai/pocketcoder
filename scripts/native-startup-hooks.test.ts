import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeStartupHooks } from "./native-startup-hooks";

test("diagnostic hooks still match the controller startup source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-startup-hooks-"));
  try {
    const built = await Bun.build({
      entrypoints: ["packages/cli/src/index.ts"],
      target: "bun",
      outdir: directory,
      plugins: [nativeStartupHooks()],
    });
    expect(built.success).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
