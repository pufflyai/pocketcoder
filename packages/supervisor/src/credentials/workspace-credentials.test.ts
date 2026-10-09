import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceCredentials } from "./workspace-credentials";

function credential(path: string) {
  return {
    path,
    lease_id: randomUUID(),
    credential: randomUUID(),
    purpose: "runtime-issuer" as const,
    expires_at: new Date(Date.now() + 5000).toISOString(),
  };
}

test("replacing the lease directory with a persistent symlink cannot redirect refreshes or deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-held-lease-"));
  const memory = join(root, "memory");
  const moved = join(root, "moved-memory");
  const persistent = join(root, "persistent");
  await mkdir(memory, { mode: 0o700 });
  await mkdir(persistent, { mode: 0o700 });
  const path = join(memory, "runtime");
  const manager = new WorkspaceCredentials({ send: () => true, expired() {}, addSecret() {} });
  try {
    await manager.install([credential(path)]);
    await rename(memory, moved);
    await symlink(persistent, memory);
    const refreshed = credential(path);
    await manager.install([refreshed]);
    expect(await readdir(persistent)).toEqual([]);
    expect(await readFile(join(moved, "runtime"), "utf8")).toBe(refreshed.credential);
    await manager.stop();
    expect(await readdir(moved)).toEqual([]);
    expect(await readdir(persistent)).toEqual([]);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a preexisting lease-directory symlink never receives a credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-initial-lease-"));
  const persistent = join(root, "persistent");
  const memory = join(root, "memory");
  await mkdir(persistent, { mode: 0o700 });
  await symlink(persistent, memory);
  const manager = new WorkspaceCredentials({ send: () => true, expired() {}, addSecret() {} });
  try {
    await expect(manager.install([credential(join(memory, "runtime"))])).rejects.toThrow();
    expect(await readdir(persistent)).toEqual([]);
  } finally {
    await manager.stop();
    await rm(root, { recursive: true, force: true });
  }
});
