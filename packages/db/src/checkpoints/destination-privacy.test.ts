import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointDestination } from "./destination";
import { createCheckpointEntryIndex } from "./entry-index";

if (process.platform === "darwin") {
  test("mode0700 does not admit a real Darwin ACL-readable destination parent", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-acl-")));
    const parent = join(root, "parent");
    const directory = join(root, "scratch");
    await mkdir(parent, { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const index = createCheckpointEntryIndex(directory, { maxBytes: 1000, check() {} });
    const rule = "everyone allow list,search,add_file,add_subdirectory,delete_child";
    const child = Bun.spawn(["chmod", "+a", rule, parent], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    try {
      await expect(
        createCheckpointDestination(
          [{ parent, policy: { name: "worktree", target: "/workspace", maxBytes: 1, maxFiles: 1 } }],
          index.seal(),
          { directory, maxCustodyBytes: 1000, check() {} },
        ),
      ).rejects.toThrow("ACL");
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      await index.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

if (process.platform === "linux") {
  test("mode0700 admits an owned Linux tmpfs parent without POSIX ACLs", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-acl-")));
    const parent = join(root, "parent");
    const directory = join(root, "scratch");
    await mkdir(parent, { mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
    const index = createCheckpointEntryIndex(directory, { maxBytes: 1000, check() {} });
    try {
      const destination = await createCheckpointDestination(
        [{ parent, policy: { name: "worktree", target: "/workspace", maxBytes: 1, maxFiles: 1 } }],
        index.seal(),
        { directory, maxCustodyBytes: 1000, check() {} },
      );
      await destination.close();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      await index.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
