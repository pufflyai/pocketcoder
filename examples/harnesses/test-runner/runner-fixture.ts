import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_MARKER, type RunRequest, type RunResult } from "./protocol";
import { git } from "./source";

export async function runnerFixture(files: Record<string, string>, options: { workspace?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "runner-test-"));
  const source = join(root, "source");
  await mkdir(source);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), content);
  }
  await git(source, "init", "-q");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "source");
  const sha = await git(source, "rev-parse", "HEAD"),
    tree = await git(source, "rev-parse", "HEAD^{tree}");
  await git(source, "update-ref", "refs/heads/base", sha);
  const path = join(root, "base.bundle");
  await git(source, "bundle", "create", path, "refs/heads/base");
  const bundle = Bun.file(path),
    bytes = await bundle.bytes();
  const uploads = new Map<string, Uint8Array>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "PUT") {
        uploads.set(path, await request.bytes());
        return new Response();
      }
      return new Response(bundle);
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  const request: RunRequest = {
    type: "pocketcoder.remote-test/v2",
    runId: randomUUID(),
    releaseAfterRun: false,
    source: {
      kind: "commit",
      base: {
        ref: "origin/main",
        sha,
        bundle: { url: `${url}/base`, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") },
      },
      head: { sha, tree, bundle: null },
      overlay: null,
    },
    requires: ["git-history"],
    command: "true",
    timeoutSeconds: 60,
    deadlineAt: new Date(Date.now() + 360_000).toISOString(),
    runtime: { template: "remote-tests@1.0.0", image: "image@sha256:example", placement: "default" },
    log: { url: `${url}/log` },
    results: { url: `${url}/results`, paths: ["test-results"], maxBytes: 1024 * 1024 },
  };
  const events: Record<string, unknown>[] = [];
  const child = Bun.spawn(["bun", join(import.meta.dir, "runner.ts")], {
    env: {
      ...process.env,
      DOCKER_HOST: `unix://${root}/missing.sock`,
      REMOTE_TEST_WORKSPACE: options.workspace ?? join(root, "workspace"),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const settled = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) events.push(JSON.parse(line));
        if (events.at(-1)?.type === "agent_settled") {
          const end = events.findLast((e) => e.type === "message_end") as { message: { content: { text: string }[] } };
          const result = end.message.content[0]!.text.split("\n").find((s) => s.startsWith(RESULT_MARKER))!;
          return JSON.parse(result.slice(RESULT_MARKER.length)) as RunResult;
        }
        index = buffer.indexOf("\n");
      }
    }
    throw new Error("Runner exited without a result");
  })();
  const send = (value: unknown) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stdin.flush();
  };
  return {
    request,
    uploads,
    root,
    events,
    settled,
    send,
    start: () => send({ type: "prompt", message: JSON.stringify(request) }),
    async cleanup() {
      child.kill();
      await child.exited;
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
