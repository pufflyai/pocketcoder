import { link, mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Logical sizes and hard-link duplicates would overstate the manager's private-volume use.
export const volumeUsageFile = import.meta.path;

async function probeImageVolumeUsage() {
  const directory = await mkdtemp(join(tmpdir(), "pc-image-volume-"));
  try {
    const file = join(directory, "sparse");
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.truncate(16 * 1024 ** 2);
      await handle.write(Buffer.alloc(4096), 0, 4096, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(file, join(directory, "same-file"));
    const [root, sparse] = await Promise.all([stat(directory), stat(file)]);
    const child = Bun.spawn(["du", "-s", "-B1", "-x", directory], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw new Error(`GNU volume observation failed: ${stderr}`);
    const bytes = Number(stdout.trim().split(/\s+/)[0]);
    const allocated = (root.blocks + sparse.blocks) * 512;
    if (bytes !== allocated || bytes >= sparse.size)
      throw new Error(`Physical volume bytes differ: ${bytes}, allocated ${allocated}, logical ${sparse.size}`);
    return { bytes, allocated, sparseBytes: sparse.size, hardLinkCountedOnce: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(await probeImageVolumeUsage()));
