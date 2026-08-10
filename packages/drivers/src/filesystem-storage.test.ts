import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistenceMount } from "@pstdio/pocketcoder-contracts";
import { FilesystemStorageDriver } from "./filesystem-storage";
import { KubernetesPvcStorageDriver } from "./kubernetes-storage";

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) {
    await chmod(path, 0o700).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
});

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "pocketcoder-storage-test-"));
  cleanup.push(root);
  return {
    root,
    workspaceRoot: join(root, "workspaces"),
    checkpointRoot: join(root, "checkpoints"),
  };
}

const mounts: PersistenceMount[] = [
  {
    name: "worktree",
    target: "/workspace",
    maxBytes: 1_048_576,
    maxFiles: 100,
  },
];
const worktreeMount = mounts[0] as PersistenceMount;

describe("filesystem checkpoint storage", () => {
  test("snapshots, verifies, and restores independent writable forks", async () => {
    const paths = await roots();
    const driver = new FilesystemStorageDriver(paths);
    const source = await driver.allocate({
      storageId: randomUUID(),
      workspaceId: randomUUID(),
      mounts,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    });
    const sourceRoot = String(source.ref.root);
    await mkdir(join(sourceRoot, "worktree", "src"), { recursive: true });
    const sourceFile = join(sourceRoot, "worktree", "src", "index.ts");
    await writeFile(sourceFile, "export const ok = true;\n");
    await chmod(sourceFile, 0o640);
    const sourceMtime = new Date("2024-01-02T03:04:05.000Z");
    await utimes(sourceFile, sourceMtime, sourceMtime);
    await symlink("src/index.ts", join(sourceRoot, "worktree", "current.ts"));

    const snapshot = await driver.snapshot(source.ref, randomUUID(), "sha256:template", mounts);
    expect(snapshot.manifest.file_count).toBe(3);
    expect(snapshot.manifest.logical_bytes).toBeGreaterThan(0);
    await expect(driver.verifyCheckpoint(snapshot.ref, snapshot.manifest)).resolves.toEqual(
      snapshot.manifest,
    );

    const fork = await driver.allocate({
      storageId: randomUUID(),
      workspaceId: randomUUID(),
      mounts,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    });
    await driver.cloneCheckpoint(snapshot.ref, fork.ref, snapshot.manifest);
    const restored = join(String(fork.ref.root), "worktree", "src", "index.ts");
    expect(await readFile(restored, "utf8")).toBe("export const ok = true;\n");
    const restoredStat = await lstat(restored);
    expect(restoredStat.mode & 0o777).toBe(0o640);
    expect(Math.abs(restoredStat.mtimeMs - sourceMtime.getTime())).toBeLessThan(2_000);
    expect(
      (await lstat(join(String(fork.ref.root), "worktree", "current.ts"))).isSymbolicLink(),
    ).toBe(true);
    await writeFile(restored, "fork-only\n");
    await expect(driver.verifyCheckpoint(snapshot.ref, snapshot.manifest)).resolves.toEqual(
      snapshot.manifest,
    );
    expect(
      await readFile(join(String(snapshot.ref.root), "worktree", "src", "index.ts"), "utf8"),
    ).toBe("export const ok = true;\n");
    await chmod(join(String(snapshot.ref.root), "worktree", "src", "index.ts"), 0o600);
    await writeFile(join(String(snapshot.ref.root), "worktree", "src", "index.ts"), "corrupted\n");
    await expect(driver.verifyCheckpoint(snapshot.ref, snapshot.manifest)).rejects.toThrow(
      "content digest mismatch",
    );
    await driver.deleteCheckpoint(snapshot.ref);
    await driver.deleteStorage(fork.ref);
  });

  test("rejects escaping symlinks and measured quota overflow", async () => {
    const paths = await roots();
    const driver = new FilesystemStorageDriver(paths);
    const allocation = await driver.allocate({
      storageId: randomUUID(),
      workspaceId: randomUUID(),
      mounts: [{ ...worktreeMount, maxBytes: 4 }],
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    });
    const worktree = join(String(allocation.ref.root), "worktree");
    await writeFile(join(worktree, "large"), "too large");
    await expect(
      driver.snapshot(allocation.ref, randomUUID(), "sha256:template", [
        { ...worktreeMount, maxBytes: 4 },
      ]),
    ).rejects.toThrow("maxBytes");
    await rm(join(worktree, "large"));
    await symlink("../../etc/passwd", join(worktree, "escape"));
    await expect(
      driver.snapshot(allocation.ref, randomUUID(), "sha256:template", mounts),
    ).rejects.toThrow("symlink");
    await expect(
      driver.deleteStorage({
        kind: "filesystem",
        id: randomUUID(),
        root: paths.workspaceRoot,
      }),
    ).rejects.toThrow("opaque allocation");
  });

  test("maps the same backend contract to Kubernetes PVC subpaths", async () => {
    const paths = await roots();
    const driver = new KubernetesPvcStorageDriver({
      ...paths,
      workspaceClaimName: "pocketcoder-workspaces",
      workspaceClaimSubPath: "runtime/workspaces",
    });
    const storageId = randomUUID();
    const allocation = await driver.allocate({
      storageId,
      workspaceId: randomUUID(),
      mounts,
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
    });
    expect(allocation.mounts).toEqual([
      {
        name: "worktree",
        target: "/workspace",
        source: {
          kind: "pvc",
          claimName: "pocketcoder-workspaces",
          subPath: `runtime/workspaces/${storageId}/worktree`,
        },
      },
    ]);
  });
});
