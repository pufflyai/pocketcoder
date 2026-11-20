import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResultArchive } from "./result-archive";

test("stops compressed output at the snapshot limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-limit-"));
  const archive = join(root, "output.tar.gz");
  try {
    await Bun.write(join(root, "noise.bin"), randomBytes(4 * 1024 * 1024));
    await expect(
      writeResultArchive(root, ["noise.bin"], archive, 32768, AbortSignal.timeout(2000), true),
    ).rejects.toThrow("Results exceed maxBytes");
    expect((await stat(archive)).size).toBeLessThanOrEqual(32768);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "keeps a changing GNU tar snapshot but requires stable final results",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "snapshot-changing-"));
    try {
      await Bun.write(join(root, "changing.txt"), new Uint8Array(1024 * 1024));
      const args = [
        "changing.txt",
        "--checkpoint=10",
        `--checkpoint-action=exec=printf x >> ${join(root, "changing.txt")}`,
      ];
      const archive = join(root, "output.tar.gz");
      await writeResultArchive(root, args, archive, 2 * 1024 * 1024, AbortSignal.timeout(5000), true);
      const listed = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe" });
      expect(await new Response(listed.stdout).text()).toContain("changing.txt");
      expect(await listed.exited).toBe(0);
      await expect(
        writeResultArchive(root, args, archive, 2 * 1024 * 1024, AbortSignal.timeout(5000), false),
      ).rejects.toThrow("file changed as we read it");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
