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

test("collects declared temporary reports without copying the disposable source tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-temporary-"));
  const repo = join(root, "repo"),
    temporary = join(root, "tmp");
  let bytes = Buffer.alloc(0);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bytes = Buffer.from(await request.arrayBuffer());
      return new Response();
    },
  });
  try {
    await mkdir(repo);
    await Bun.write(join(temporary, "private-review/checks.json"), '{"outcome":"failure"}');
    await Bun.write(join(temporary, "private-review/source/test-results/browser/trace.zip"), "retained-trace");
    await Bun.write(
      join(temporary, "private-review/source/packages/e2e/test-results/failure/trace.zip"),
      "nested-review-trace",
    );
    await Bun.write(join(temporary, "private-review/source/node_modules/large.bin"), "excluded");
    const request = {
      results: {
        url: `http://127.0.0.1:${server.port}`,
        paths: ["test-results"],
        temporaryPaths: ["*/checks.json", "*/source/test-results", "*/source/*/*/test-results"],
        maxBytes: 1024 * 1024,
      },
    };
    const archive = join(root, "collected.tar.gz");
    await uploadResults(request, repo, archive, AbortSignal.timeout(2000), false, temporary);
    await Bun.write(archive, bytes);
    const child = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe" });
    const entries = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(entries).toContain("tmp/private-review/checks.json");
    expect(entries).toContain("tmp/private-review/source/test-results/browser/trace.zip");
    expect(entries).toContain("tmp/private-review/source/packages/e2e/test-results/failure/trace.zip");
    expect(entries).not.toContain("node_modules");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("retains nested monorepo traces without archiving dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-nested-"));
  let bytes = Buffer.alloc(0);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      bytes = Buffer.from(await request.arrayBuffer());
      return new Response();
    },
  });
  try {
    await Bun.write(join(root, "test-results/execution.json"), "root-report");
    await Bun.write(join(root, "packages/e2e/test-results/failure/trace.zip"), "nested-trace");
    await Bun.write(join(root, "clients/desktop/test-results/failure/error-context.md"), "desktop-context");
    await Bun.write(join(root, "node_modules/tool/test-results/excluded.txt"), "dependency-report");
    await Bun.write(join(root, "--exclude=packages/e2e/test-results"), "literal report operand");
    const archive = join(root, "collected.tar.gz");
    await uploadResults(
      {
        results: {
          url: `http://127.0.0.1:${server.port}`,
          paths: ["test-results", "*/test-results", "*/*/test-results"],
          maxBytes: 1024 * 1024,
        },
      },
      root,
      archive,
      AbortSignal.timeout(2000),
    );
    await Bun.write(archive, bytes);
    const child = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe" });
    const entries = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(entries).toContain("test-results/execution.json");
    expect(entries).toContain("packages/e2e/test-results/failure/trace.zip");
    expect(entries).toContain("clients/desktop/test-results/failure/error-context.md");
    expect(entries).toContain("./--exclude=packages/e2e/test-results");
    expect(entries).not.toContain("node_modules");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
