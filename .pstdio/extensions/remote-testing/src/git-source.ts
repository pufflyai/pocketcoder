import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSource } from "@pstdio/pocketcoder-example-test-runner/protocol";
import type { ExtensionProcessApi } from "@pstdio/sdk/extensions";

type ObjectRef = { url: string; sha256: string };
export async function withGitSource<T>(
  process: ExtensionProcessApi,
  root: string,
  ref: string | undefined,
  use: (value: {
    source: GitSource;
    objects: Record<string, { file: ReturnType<typeof Bun.file>; reference: ObjectRef }>;
  }) => Promise<T>,
  baseSha?: string,
) {
  const git = async (cwd: string, ...args: string[]) =>
    (
      await process.runOrThrow({
        command: ["git", "-C", cwd, ...args],
        timeoutMs: 300_000,
      })
    ).stdout;
  const head = (await git(root, "rev-parse", "--verify", "--end-of-options", `${ref ?? "HEAD"}^{commit}`)).trim();
  const base = (await git(root, "rev-parse", "--verify", `${baseSha ?? "refs/remotes/origin/main"}^{commit}`)).trim();
  const tree = (await git(root, "rev-parse", `${head}^{tree}`)).trim();
  const dir = await mkdtemp(join(tmpdir(), "remote-test-bundles-"));
  const objects: Record<string, { file: ReturnType<typeof Bun.file>; reference: ObjectRef }> = {};
  const object = async (name: string) => {
    const file = Bun.file(join(dir, name));
    const hash = new Bun.CryptoHasher("sha256");
    for await (const chunk of file.stream()) hash.update(chunk);
    const reference = { url: "", sha256: hash.digest("hex") };
    objects[name] = { file, reference };
    return reference;
  };
  try {
    // Temporary refs never touch the user's repository, index or remote configuration.
    const bare = join(dir, "git");
    await process.runOrThrow({
      command: ["git", "clone", "--bare", "--shared", "--quiet", root, bare],
      timeoutMs: 300_000,
    });
    await git(bare, "update-ref", "refs/heads/base", base);
    await git(bare, "update-ref", "refs/heads/candidate", head);
    await git(bare, "bundle", "create", join(dir, "base.bundle"), "refs/heads/base");
    const extra = await git(bare, "rev-list", head, `^${base}`);
    let headBundle: ObjectRef | null = null;
    if (extra) {
      await git(bare, "bundle", "create", join(dir, "head.bundle"), "refs/heads/candidate", `^${base}`);
      headBundle = await object("head.bundle");
    }
    const overlay = ref ? null : await createOverlay(process, root, dir, git, object, objects);
    return await use({
      source: {
        kind: overlay ? "dirty" : "commit",
        base: { ref: "origin/main", sha: base, bundle: await object("base.bundle") },
        head: { sha: head, tree, bundle: headBundle },
        overlay,
      },
      objects,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createOverlay(
  process: ExtensionProcessApi,
  root: string,
  dir: string,
  git: (cwd: string, ...args: string[]) => Promise<string>,
  object: (name: string) => Promise<ObjectRef>,
  objects: Record<string, { file: ReturnType<typeof Bun.file>; reference: ObjectRef }>,
) {
  let overlay: GitSource["overlay"] = null;
  const changed = await git(root, "diff", "--name-only", "-z", "HEAD");
  const untracked = await git(root, "ls-files", "--others", "--exclude-standard", "-z");
  const names = [...new Set(`${changed}\0${untracked}`.split("\0").filter(Boolean))];
  if (names.length) {
    const files: string[] = [],
      deleted: string[] = [];
    for (const name of names) {
      const stat = await lstat(join(root, name)).catch(() => null);
      if (!stat) deleted.push(name);
      else if (!stat.isDirectory()) files.push(name);
      else throw new Error("Git submodules are not supported by exact source transfer.");
    }
    await writeFile(join(dir, "files"), files.length ? `${files.join("\0")}\0` : "");
    await process.runOrThrow({
      command: ["tar", "-czf", join(dir, "overlay.tar.gz"), "-C", root, "--null", "-T", join(dir, "files")],
      env: { PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      timeoutMs: 300_000,
    });
    overlay = { ...(await object("overlay.tar.gz")), deleted };
    objects["overlay.tar.gz"]!.reference = overlay;
  }
  return overlay;
}
