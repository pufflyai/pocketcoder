import { createHash } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { GitSource } from "./protocol";

export async function git(repo: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}
async function download(ref: { url: string; sha256: string }, path: string, signal: AbortSignal) {
  const response = await fetch(ref.url, { signal });
  if (!response.ok) throw new Error(`Source download failed with HTTP ${response.status}`);
  const bytes = await response.bytes();
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("Source digest mismatch");
  await Bun.write(path, bytes);
}
function safePath(path: string) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).some((p) => p === ".." || p === ".git"))
    throw new Error("Unsafe source path");
  return path;
}
export async function installSource(source: GitSource, repo: string, signal: AbortSignal) {
  await mkdir(repo, { recursive: true });
  for (const entry of await readdir(repo))
    if (entry !== "node_modules") await rm(join(repo, entry), { recursive: true, force: true });
  const base = `${repo}.base.bundle`,
    head = `${repo}.head.bundle`,
    overlay = `${repo}.overlay.tar.gz`;
  try {
    await download(source.base.bundle, base, signal);
    await git(repo, "init", "-q");
    await git(repo, "fetch", "--quiet", base, "refs/heads/base:refs/remotes/origin/main");
    if ((await git(repo, "rev-parse", "origin/main")) !== source.base.sha) throw new Error("Source base mismatch");
    if (source.head.bundle) {
      await download(source.head.bundle, head, signal);
      await git(repo, "fetch", "--quiet", head, "refs/heads/candidate:refs/heads/candidate");
      if ((await git(repo, "rev-parse", "candidate")) !== source.head.sha) throw new Error("Source head mismatch");
    }
    await git(repo, "checkout", "--quiet", "--detach", source.head.sha);
    if ((await git(repo, "rev-parse", "HEAD^{tree}")) !== source.head.tree) throw new Error("Source tree mismatch");
    const mergeBase = await git(repo, "merge-base", "origin/main", "HEAD");
    if (source.overlay) {
      await download(source.overlay, overlay, signal);
      for (const path of source.overlay.deleted) await rm(join(repo, safePath(path)), { force: true });
      const tar = Bun.spawn(["tar", "-xzf", overlay, "-C", repo], { stderr: "pipe" });
      const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
      if (code !== 0) throw new Error(`Source overlay failed: ${stderr}`);
    }
    return { kind: source.kind, head: source.head.sha, base: source.base.sha, tree: source.head.tree, mergeBase };
  } finally {
    await Promise.all([base, head, overlay].map((p) => rm(p, { force: true })));
  }
}
