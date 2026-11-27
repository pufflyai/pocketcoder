import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "../e2e/local-process";
import { nativeRecord } from "./artifact";

test("one executable starts and restarts outside the checkout without Bun or adjacent assets", async () => {
  const root = resolve(import.meta.dir, "../..");
  await command([process.execPath, "run", "build:native"], { quiet: true });
  // A separate Bun process keeps the full test runner's pre-exec peak out of the Linux measurement.
  const result = await command(
    [
      "sh",
      "-c",
      '"$@"',
      "pc-native-restart",
      process.execPath,
      join(import.meta.dir, "restart-fixture.ts"),
      join(root, "out/native/pocketcoder"),
    ],
    { quiet: true },
  );
  const measurements = JSON.parse(result.stdout);
  expect(measurements.starts).toHaveLength(2);
  console.log(result.stdout);
}, 30_000);

test("an installed binary restores its backup and matches its recorded embedded format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-native-artifact-"));
  const root = resolve(import.meta.dir, "../..");
  const commit = "a".repeat(40);
  // Linux's pre-exec peak must not charge the test runner's buffers to the controller.
  const parentArtifact = Buffer.alloc(process.platform === "linux" ? 512_000_000 : 1, 1);
  try {
    await command([process.execPath, "run", "build:native"], { quiet: true });
    const binary = join(root, "out/native/pocketcoder");
    const record = await nativeRecord(binary, commit);
    await Bun.write(join(directory, "pocketcoder"), Bun.file(binary));
    await Bun.write(join(directory, "native.json"), JSON.stringify(record));
    // A small shell gives the checker its own Linux RSS history before it starts the controller.
    const checked = await command(
      [
        "sh",
        "-c",
        '"$@"',
        "pc-installed-native",
        process.execPath,
        join(import.meta.dir, "installed.ts"),
        directory,
        commit,
      ],
      { quiet: true },
    );
    const result = JSON.parse(checked.stdout);
    expect(result.result).toBe("passed");
    expect(result.bunInControllerPath).toBe(false);
    expect(result.starts).toHaveLength(4);
    expect(parentArtifact[0]).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
