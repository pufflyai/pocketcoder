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
