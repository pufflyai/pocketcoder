import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { createVerifiedCheckpointArchive } from "@pstdio/pocketcoder-db/checkpoints";
import { createFilesystemCheckpointDownload } from "./filesystem-download";
import { checkpointDigest, downloadFixture } from "./filesystem-download-fixture";

function deepGraph(mtime: string) {
  const entries: CheckpointArchiveEntry[] = [];
  let path = "d";
  for (let depth = 0; depth < 34; depth++) {
    entries.push({ mount: 0, path, kind: "directory", mode: depth % 2 ? 0o500 : 0o700, mtime_ns: mtime, size: 0 });
    path += "/d";
  }
  entries.push({
    mount: 0,
    path: `${path.slice(0, -2)}/empty`,
    kind: "file",
    mode: 0o600,
    mtime_ns: mtime,
    size: 0,
    digest: checkpointDigest(""),
  });
  return entries;
}

test("deep graph verification keeps admission checks within bounded work", async () => {
  const f = await downloadFixture();
  let checks = 0;
  const entries = deepGraph(f.mtime);
  const header = {
    ...f.header,
    mounts: f.header.mounts.map((mount, ordinal) => ({
      ...mount,
      file_count: ordinal === 0 ? entries.length : 0,
      logical_bytes: 0,
    })),
  };
  try {
    const source = await f.boundArchive(entries, header);
    const archive = await createVerifiedCheckpointArchive(source.stream, {
      ...f.options,
      check() {
        checks++;
        f.options.check();
      },
      authorizeHeader: async () => {},
    });
    try {
      expect(archive.receipt.entryCount).toBe(35);
      expect(checks).toBeLessThanOrEqual(entries.length * 320);
    } finally {
      await archive.close();
    }
  } finally {
    await f.close();
  }
});

test("mode000 directories retain exact metadata and remain removable through owned native cleanup", async () => {
  const f = await downloadFixture();
  try {
    const entries = f.entries.map((entry) =>
      entry.kind !== "symlink" && (entry.path === "z" || entry.path === "a") ? { ...entry, mode: 0 } : entry,
    );
    const source = await f.boundArchive(entries);
    const prepared = await createFilesystemCheckpointDownload(source.stream, source.binding, f.mounts, f.options);
    try {
      const mount = prepared.mounts[0];
      if (!mount) throw new Error("Expected worktree mount");
      const directory = await lstat(join(mount.path, "z"), { bigint: true });
      expect(directory.mode & 0o777n).toBe(0n);
      expect(directory.mtimeNs.toString()).toBe(f.mtime);
      const file = await lstat(join(mount.path, "a"), { bigint: true });
      expect(file.mode & 0o777n).toBe(0n);
      expect(file.size).toBe(BigInt(f.bytes.length));
      expect(file.mtimeNs.toString()).toBe(f.mtime);
      prepared.validate();
    } finally {
      await prepared.close();
    }
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.scratch)).toEqual([]);
  } finally {
    await f.close();
  }
});

async function deepExtraction(signal: AbortSignal) {
  const f = await downloadFixture();
  const baseline = readdirSync("/dev/fd").length;
  let maximum = baseline;
  const entries = deepGraph(f.mtime);
  const header = {
    ...f.header,
    mounts: f.header.mounts.map((mount, ordinal) => ({
      ...mount,
      file_count: ordinal === 0 ? entries.length : 0,
      logical_bytes: 0,
    })),
  };
  const mounts = f.mounts.map((mount) => ({ ...mount, policy: { ...mount.policy, maxFiles: 10_000_000 } }));
  try {
    const source = await f.boundArchive(entries, header);
    const prepared = await createFilesystemCheckpointDownload(source.stream, source.binding, mounts, {
      ...f.options,
      signal,
      check() {
        f.options.check();
        maximum = Math.max(maximum, readdirSync("/dev/fd").length);
      },
    });
    try {
      expect(prepared.receipt.entryCount).toBe(35);
      expect(maximum - baseline).toBeLessThanOrEqual(24);
      const mount = prepared.mounts[0];
      if (!mount) throw new Error("Expected worktree mount");
      for (const entry of entries) {
        const stat = await lstat(join(mount.path, entry.path), { bigint: true });
        expect(stat.mode & 0o777n).toBe(BigInt(entry.mode));
        expect(stat.mtimeNs.toString()).toBe(f.mtime);
      }
    } finally {
      await prepared.close();
    }
    expect(await readdir(f.work)).toEqual([]);
    expect(await readdir(f.state)).toEqual([]);
    expect(readdirSync("/dev/fd").length).toBe(baseline);
  } finally {
    await f.close();
  }
}
describe("deep extraction ownership", () => {
  let abort: AbortController | undefined;
  let pending: Promise<void> | undefined;
  afterEach(async () => {
    // Bun can leave a timed-out async test running; drain its ownership before the next FD census.
    abort?.abort(new Error("Deep extraction test completed or timed out."));
    await pending?.catch(() => {});
    pending = undefined;
    abort = undefined;
  });
  test("deep complete graph extraction uses a constant native descriptor budget", () => {
    abort = new AbortController();
    pending = deepExtraction(abort.signal);
    void pending.catch(() => {});
    return pending;
  });
  test("canceled deep materialization drains stages before the next descriptor census", async () => {
    const f = await downloadFixture();
    const baseline = readdirSync("/dev/fd").length;
    const abort = new AbortController();
    const entries = deepGraph(f.mtime);
    const header = {
      ...f.header,
      mounts: f.header.mounts.map((mount, ordinal) => ({
        ...mount,
        file_count: ordinal === 0 ? entries.length : 0,
        logical_bytes: 0,
      })),
    };
    let materialized = false;
    try {
      const source = await f.boundArchive(entries, header);
      const mounts = f.mounts.map((mount) => ({ ...mount, policy: { ...mount.policy, maxFiles: 10_000_000 } }));
      const downloading = createFilesystemCheckpointDownload(source.stream, source.binding, mounts, {
        ...f.options,
        signal: abort.signal,
        check() {
          f.options.check();
          const stage = readdirSync(f.work).find((name) => name.startsWith(".checkpoint-stage-"));
          if (!stage || !existsSync(join(f.work, stage, "d/d/d/d"))) return;
          materialized = true;
          abort.abort(new Error("deep restore canceled"));
        },
      });
      await expect(downloading).rejects.toThrow("deep restore canceled");
      expect(materialized).toBe(true);
      expect(await readdir(f.work)).toEqual([]);
      expect(await readdir(f.state)).toEqual([]);
      expect(await readdir(f.scratch)).toEqual([]);
      expect(readdirSync("/dev/fd").length).toBe(baseline);
    } finally {
      await f.close();
    }
  });
});

test("a replaced staged root is quarantined and its foreign replacement is never removed", async () => {
  const f = await downloadFixture();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, f.options);
    const mount = prepared.mounts[0];
    if (!mount) throw new Error("Expected worktree mount");
    const retained = join(f.work, "retained-original");
    await rename(mount.path, retained);
    await mkdir(mount.path);
    await writeFile(join(mount.path, "foreign"), "must remain");
    expect(() => prepared.validate()).toThrow();
    await expect(prepared.close()).rejects.toThrow("reconciliation");
    expect(await readFile(join(mount.path, "foreign"), "utf8")).toBe("must remain");
    expect(await readFile(join(retained, "a"))).toEqual(f.bytes);
  } finally {
    const directory = join(f.work, "retained-original", "z");
    if (existsSync(directory)) await chmod(directory, 0o700);
    await f.close();
  }
});

test("filesystem download bundle excludes database engine and ORM initialization", async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(import.meta.resolve("./filesystem-download"))],
    target: "bun",
  });
  expect(build.success).toBe(true);
  expect(await build.outputs[0]?.text()).not.toMatch(/PGlite|electric-sql|drizzle-orm|pglite\.wasm/);
});

test("fresh prepared graph verification refuses later same-inode file changes and keeps them quarantined", async () => {
  const f = await downloadFixture();
  try {
    const prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, f.options);
    const mount = prepared.mounts[0];
    if (!mount) throw new Error("Expected worktree mount");
    const path = join(mount.path, "a");
    const original = await lstat(path, { bigint: true });
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(f.bytes.length, 42));
    expect((await lstat(path, { bigint: true })).ino).toBe(original.ino);
    await expect(prepared.verify()).rejects.toThrow("changed");
    await expect(prepared.close()).rejects.toThrow("reconciliation");
    expect(await readFile(path)).toEqual(Buffer.alloc(f.bytes.length, 42));
  } finally {
    for (const stage of await readdir(f.work)) {
      const directory = join(f.work, stage, "z");
      if (existsSync(directory)) await chmod(directory, 0o700);
    }
    await f.close();
  }
});

test("a caller callback after an awaited census cannot bypass the final prepared content proof", async () => {
  const f = await downloadFixture();
  let prepared: Awaited<ReturnType<typeof createFilesystemCheckpointDownload>> | undefined;
  let calls = 0;
  let mutateAt = Number.POSITIVE_INFINITY;
  let path = "";
  try {
    prepared = await createFilesystemCheckpointDownload(f.archive(), f.binding, f.mounts, {
      ...f.options,
      check() {
        f.options.check();
        if (++calls !== mutateAt) return;
        chmodSync(path, 0o600);
        writeFileSync(path, Buffer.alloc(f.bytes.length, 42));
      },
    });
    const mount = prepared.mounts[0];
    if (!mount) throw new Error("Expected worktree mount");
    path = join(mount.path, "a");
    calls = 0;
    await prepared.verify();
    mutateAt = calls;
    calls = 0;
    await expect(prepared.verify()).rejects.toThrow("changed");
    await expect(prepared.close()).rejects.toThrow("reconciliation");
    expect(await readFile(path)).toEqual(Buffer.alloc(f.bytes.length, 42));
  } finally {
    await prepared?.close().catch(() => {});
    for (const stage of await readdir(f.work)) {
      const directory = join(f.work, stage, "z");
      if (existsSync(directory)) await chmod(directory, 0o700);
    }
    await f.close();
  }
});
