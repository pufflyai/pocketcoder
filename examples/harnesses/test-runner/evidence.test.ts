import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadResults } from "./evidence";

test("uploads a self-described partial archive before final results exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-snapshot-"));
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bytes = await request.bytes();
      return new Response();
    },
  });
  try {
    await mkdir(join(root, "test-results"));
    await Bun.write(join(root, "test-results/checks.json"), JSON.stringify({ partial: true }));
    const archive = join(root, "snapshot.tar.gz");
    await uploadResults(
      { results: { url: `http://127.0.0.1:${server.port}`, paths: ["test-results"], maxBytes: 1024 * 1024 } },
      root,
      archive,
      AbortSignal.timeout(1000),
      true,
    );
    await Bun.write(archive, Buffer.from(bytes));
    const child = Bun.spawn(["tar", "-xOzf", archive, "evidence-snapshot.json"], { stdout: "pipe" });
    const metadata = (await new Response(child.stdout).json()) as { complete: boolean; capturedAt: string };
    expect(await child.exited).toBe(0);
    expect(metadata.complete).toBe(false);
    expect(Number.isFinite(Date.parse(metadata.capturedAt))).toBe(true);
    expect(new TextDecoder().decode(Bun.gunzipSync(Buffer.from(bytes)))).toContain('"partial":true');
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
