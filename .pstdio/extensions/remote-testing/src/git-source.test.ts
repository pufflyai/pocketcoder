import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSource } from "@pstdio/pocketcoder-example-test-runner/protocol";
import { installSource } from "@pstdio/pocketcoder-example-test-runner/source";
import { withGitSource } from "./git-source";
import { localProcess } from "./process-fixture";

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "git-source-"));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function git(root: string, ...args: string[]) {
  return (await localProcess.runOrThrow({ command: ["git", "-C", root, ...args] })).stdout.trim();
}
async function fixture() {
  const root = await directory();
  await git(root, "init", "-q");
  await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(root, "run.sh"), 0o755);
  await symlink("run.sh", join(root, "link"));
  await git(root, "add", ".");
  await git(root, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "base");
  await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  await writeFile(join(root, "new.txt"), "head");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "head");
  return root;
}
async function roundTrip(root: string, ref?: string, alter?: (source: GitSource) => void) {
  return withGitSource(localProcess, root, ref, async (packed) => {
    const objects = new Map<string, Blob>();
    const server = Bun.serve({
      port: 0,
      fetch: (request) => new Response(objects.get(new URL(request.url).pathname) ?? null),
    });
    cleanup.push(() => server.stop(true));
    const source = packed.source;
    for (const [name, item] of Object.entries(packed.objects)) {
      objects.set(`/${name}`, item.file);
      item.reference.url = `http://127.0.0.1:${server.port}/${name}`;
    }
    alter?.(source);
    const repo = join(await directory(), "repo");
    await installSource(source, repo, new AbortController().signal);
    return { repo, source };
  });
}

test("restores exact history, tree, executable bits and symlinks without a remote URL", async () => {
  const root = await fixture();
  const { repo, source } = await roundTrip(root, "HEAD");
  expect(await git(repo, "rev-parse", "HEAD")).toBe(source.head.sha);
  expect(await git(repo, "merge-base", "origin/main", "HEAD")).toBe(
    await git(root, "merge-base", "origin/main", "HEAD"),
  );
  expect(await git(repo, "status", "--porcelain")).toBe("");
  expect(await git(repo, "remote", "-v")).toBe("");
  expect(await git(repo, "ls-files", "--stage", "run.sh")).toStartWith("100755");
  expect(await readlink(join(repo, "link"))).toBe("run.sh");
});

test("keeps dirty edits, deletions and untracked files outside the head commit", async () => {
  const root = await fixture();
  await writeFile(join(root, "new.txt"), "dirty");
  await rm(join(root, "run.sh"));
  await writeFile(join(root, "untracked.txt"), "local");
  const { repo, source } = await roundTrip(root);
  expect(source.kind).toBe("dirty");
  expect(await git(repo, "rev-parse", "HEAD")).toBe(source.head.sha);
  expect(await Bun.file(join(repo, "new.txt")).text()).toBe("dirty");
  expect(await Bun.file(join(repo, "run.sh")).exists()).toBe(false);
  expect(await git(repo, "status", "--porcelain")).toContain("?? untracked.txt");
});

test("handles a head already contained in the base without an empty bundle", async () => {
  const root = await fixture();
  const { repo, source } = await roundTrip(root, "origin/main");
  expect(source.head.bundle).toBeNull();
  expect(await git(repo, "rev-parse", "HEAD")).toBe(source.base.sha);
});

test("rejects a missing base or a changed tree before a command can run", async () => {
  const root = await fixture();
  await expect(
    roundTrip(root, "HEAD", (s) => {
      s.base.bundle.sha256 = "0".repeat(64);
    }),
  ).rejects.toThrow("digest");
  await expect(
    roundTrip(root, "HEAD", (s) => {
      s.head.tree = "0".repeat(40);
    }),
  ).rejects.toThrow("tree");
});
