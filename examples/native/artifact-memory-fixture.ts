import { mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeRecord, verifyNativeArtifact } from "./artifact";

const directory = await mkdtemp(join(tmpdir(), "pc-artifact-memory-"));
try {
  const binary = join(directory, "pocketcoder");
  await Bun.write(binary, "");
  await truncate(binary, 128 * 1024 ** 2);
  const before = process.resourceUsage().maxRSS;
  const commit = "a".repeat(40);
  await Bun.write(join(directory, "native.json"), JSON.stringify(await nativeRecord(binary, commit)));
  await verifyNativeArtifact(directory, commit);
  console.log(JSON.stringify({ growthBytes: (process.resourceUsage().maxRSS - before) * 1024 }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
