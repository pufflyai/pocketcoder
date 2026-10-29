import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { createCheckpointDestination } from "./destination";
import { createCheckpointEntryIndex } from "./entry-index";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-life-")));
  const parent = join(root, "parent");
  const directory = join(root, "scratch");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  const payload = Buffer.alloc(65_536, 17);
  const entry: CheckpointArchiveEntry = {
    mount: 0,
    path: "file",
    kind: "file",
    size: payload.length,
    digest: `sha256:${createHash("sha256").update(payload).digest("hex")}`,
    mode: 0,
    mtime_ns: "1730000000123456789",
  };
  const index = createCheckpointEntryIndex(directory, { maxBytes: 1_000_000, check() {} });
  await index.append(entry);
  const complete = index.seal();
  return {
    root,
    parent,
    directory,
    payload,
    entry,
    index,
    complete,
    mounts: [{ parent, policy: { name: "worktree", target: "/workspace", maxBytes: payload.length, maxFiles: 1 } }],
    options: { directory, maxCustodyBytes: 1_000_000, check() {} },
  };
}
test.each(["abort", "close"])(
  "destination %s after a genuine native write drains the active descriptor and cleans its prefix",
  async (kind) => {
    const f = await fixture();
    const abort = new AbortController();
    let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
    let file: Awaited<ReturnType<NonNullable<typeof destination>["openFile"]>> | undefined;
    let stopped = false;
    let closing: Promise<void> | undefined;
    try {
      destination = await createCheckpointDestination(f.mounts, f.complete, {
        ...f.options,
        signal: abort.signal,
        check() {
          if (!file || stopped || fstatSync(file.descriptor).size === 0) return;
          stopped = true;
          if (kind === "abort") abort.abort(new Error("restore purged"));
          else closing = destination?.close();
        },
      });
      file = await destination.openFile(f.entry);
      await expect(file.write(f.payload)).rejects.toThrow();
      await closing;
      await destination.close();
      expect(stopped).toBe(true);
      expect(() => fstatSync(file?.descriptor ?? -1)).toThrow();
      expect(readdirSync(f.parent)).toEqual([]);
    } finally {
      await destination?.close().catch(() => {});
      await f.index.close();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
test("mode-000 nonempty file stays bound by final custody and is removed without reopening its bytes", async () => {
  const f = await fixture();
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, f.options);
    const file = await destination.openFile(f.entry);
    await file.write(f.payload);
    await file.finish();
    await destination.census();
    const mounts = await destination.preparedMounts();
    expect(mounts[0]?.name).toBe("worktree");
    await f.index.close();
    await destination.close();
    expect(readdirSync(f.parent)).toEqual([]);
    expect(readdirSync(f.directory)).toEqual([]);
  } finally {
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("close refuses a reused file descriptor and still drains its other owned handles", async () => {
  const f = await fixture();
  const baseline = readdirSync("/dev/fd").length;
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  let foreign: number | undefined;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, f.options);
    const file = await destination.openFile(f.entry);
    const path = join(f.root, "foreign");
    writeFileSync(path, "keep this descriptor");
    closeSync(file.descriptor);
    foreign = openSync(path, "r");
    expect(foreign).toBe(file.descriptor);
    await expect(destination.close()).rejects.toThrow("descriptor");
    expect(fstatSync(foreign).size).toBe(20);
    expect(readdirSync(f.parent)).toEqual([]);
    expect(readdirSync("/dev/fd").length).toBe(baseline + 1);
  } finally {
    if (foreign !== undefined) {
      try {
        closeSync(foreign);
      } catch {}
    }
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("replacement of an original private parent is quarantined without adopting or removing either tree", async () => {
  const f = await fixture();
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, f.options);
    await rename(f.parent, `${f.parent}-held`);
    await mkdir(f.parent, { mode: 0o700 });
    writeFileSync(join(f.parent, "foreign"), "unchanged");
    await expect(destination.openFile(f.entry)).rejects.toThrow();
    await expect(destination.close()).rejects.toThrow();
    expect(readFileSync(join(f.parent, "foreign"), "utf8")).toBe("unchanged");
    expect(readdirSync(`${f.parent}-held`)).toHaveLength(1);
  } finally {
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("a last prepared-result authority callback cannot invalidate already checked file metadata", async () => {
  const f = await fixture();
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  let callbacks = 0;
  let armed = false;
  let changed = false;
  try {
    destination = await createCheckpointDestination(f.mounts, f.complete, {
      ...f.options,
      check() {
        if (!armed || ++callbacks !== 4) return;
        const stage = readdirSync(f.parent)[0];
        if (!stage) throw new Error("Missing actual stage.");
        utimesSync(join(f.parent, stage, "file"), 0, 0);
        changed = true;
      },
    });
    const file = await destination.openFile(f.entry);
    await file.write(f.payload);
    await file.finish();
    await destination.census();
    armed = true;
    await expect(destination.preparedMounts()).rejects.toThrow("custody changed");
    expect(changed).toBe(true);
  } finally {
    await destination?.close().catch(() => {});
    await f.index.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test.each(["budget", "timestamp", "scratch", "nonempty", "abort"])(
  "destination %s refusal creates no stage or leaked native handle",
  async (kind) => {
    const f = await fixture();
    const baseline = readdirSync("/dev/fd").length;
    const abort = new AbortController();
    const options = { ...f.options, signal: abort.signal };
    let alternate: ReturnType<typeof createCheckpointEntryIndex> | undefined;
    let source = f.complete;
    try {
      if (kind === "budget") options.maxCustodyBytes = 1;
      if (kind === "timestamp") {
        alternate = createCheckpointEntryIndex(f.directory, { maxBytes: 1_000_000, check() {} });
        await alternate.append({ ...f.entry, mtime_ns: "999999999999999999999999999999999999" });
        source = alternate.seal();
      }
      if (kind === "scratch") options.directory = f.parent;
      if (kind === "nonempty") writeFileSync(join(f.parent, "foreign"), "kept");
      if (kind === "abort") abort.abort(new Error("already canceled"));
      await expect(createCheckpointDestination(f.mounts, source, options)).rejects.toThrow();
      expect(readdirSync(f.parent)).toEqual(kind === "nonempty" ? ["foreign"] : []);
      await alternate?.close();
      expect(readdirSync("/dev/fd").length).toBe(baseline);
      expect(existsSync(join(f.parent, "file"))).toBe(false);
    } finally {
      await alternate?.close();
      await f.index.close();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
