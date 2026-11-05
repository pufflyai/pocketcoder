import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeRecord, verifyNativeArtifact } from "./artifact";

test("a downloaded artifact is tied to its commit and rejects changed executable bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-candidate-artifact-"));
  const commit = "a".repeat(40);
  try {
    const binary = join(directory, "pocketcoder");
    await Bun.write(binary, "candidate executable bytes");
    const record = await nativeRecord(binary, commit);
    await Bun.write(join(directory, "native.json"), JSON.stringify(record));
    expect(await verifyNativeArtifact(directory, commit)).toEqual(record);
    await expect(verifyNativeArtifact(directory, "f".repeat(40))).rejects.toThrow("commit");
    await Bun.write(binary, "changed executable bytes");
    await expect(verifyNativeArtifact(directory, commit)).rejects.toThrow("checksum");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "large native artifact verification keeps memory bounded",
  async () => {
    // A small shell prevents Linux from inheriting the test runner's RSS peak across exec.
    const child = Bun.spawn(
      ["sh", "-c", '"$@"', "pc-artifact-memory", process.execPath, join(import.meta.dir, "artifact-memory-fixture.ts")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toMatchObject({ code: 0 });
    const result = JSON.parse(stdout);
    expect(result.growthBytes).toBeLessThan(64 * 1024 ** 2);
  },
  30_000,
);
