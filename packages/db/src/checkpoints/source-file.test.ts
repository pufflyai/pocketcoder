import { expect, test } from "bun:test";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { link, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCheckpointDirectory } from "./directory-reader";
import { checkpointCustody } from "./source-custody";
import { openCheckpointSourceFile } from "./source-file";

function ownedDescriptors(paths: readonly string[]) {
  const identities = new Set(
    paths.map((path) => {
      const stat = lstatSync(path, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    }),
  );
  return readdirSync("/dev/fd")
    .map(Number)
    .filter((descriptor) => {
      try {
        const stat = fstatSync(descriptor, { bigint: true });
        return identities.has(`${stat.dev}:${stat.ino}`);
      } catch {
        // The native enumeration descriptor or another owner may already have closed.
        return false;
      }
    })
    .sort((left, right) => left - right);
}

async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pc-source-file-")));
  const bytes = Buffer.alloc(130_049, 31);
  writeFileSync(join(path, "file"), bytes);
  const custody = checkpointCustody(lstatSync(join(path, "file"), { bigint: true }));
  const directory = openCheckpointDirectory(path, () => {});
  return {
    path,
    bytes,
    custody,
    directory,
    async close() {
      directory.close();
      await rm(path, { recursive: true, force: true });
    },
  };
}

test("native no-follow reads retain exact file identity and emit at most 64 KiB", async () => {
  const f = await fixture();
  const file = openCheckpointSourceFile(f.directory, "file", f.custody, { check() {} });
  try {
    const received = [];
    let chunk = await file.read();
    while (chunk) {
      expect(chunk.length).toBeLessThanOrEqual(65_536);
      received.push(chunk);
      chunk = await file.read();
    }
    expect(Buffer.concat(received)).toEqual(f.bytes);
    expect(fstatSync(file.descriptor).nlink).toBe(1);
    await file.close();
    expect(ownedDescriptors([f.path, join(f.path, "file")])).toEqual([f.directory.descriptor]);
  } finally {
    await file.close();
    await f.close();
  }
});

test("a real same-inode content change refuses before returning another chunk", async () => {
  const f = await fixture();
  const file = openCheckpointSourceFile(f.directory, "file", f.custody, { check() {} });
  try {
    expect((await file.read())?.length).toBe(65_536);
    await Bun.sleep(2);
    writeFileSync(join(f.path, "file"), Buffer.alloc(f.bytes.length, 42));
    await expect(file.read()).rejects.toThrow("changed");
  } finally {
    await file.close();
    await f.close();
  }
});

test.each(["symlink", "hardlink", "fifo"])("refuses actual %s input without blocking or leaking", async (kind) => {
  const f = await fixture();
  f.directory.close();
  if (kind === "symlink") await symlink("file", join(f.path, "unsafe"));
  else if (kind === "hardlink") await link(join(f.path, "file"), join(f.path, "unsafe"));
  else expect(Bun.spawnSync(["mkfifo", join(f.path, "unsafe")]).exitCode).toBe(0);
  const directory = openCheckpointDirectory(f.path, () => {});
  try {
    const expected = checkpointCustody(lstatSync(join(f.path, "unsafe"), { bigint: true }));
    expect(() => openCheckpointSourceFile(directory, "unsafe", expected, { check() {} })).toThrow();
    const paths = [f.path, join(f.path, "file"), join(f.path, "unsafe")];
    const probe = openSync(join(f.path, "unsafe"), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect(ownedDescriptors(paths)).toContain(probe);
    } finally {
      closeSync(probe);
    }
    expect(ownedDescriptors(paths)).toEqual([directory.descriptor]);
  } finally {
    directory.close();
    await f.close();
  }
});

test("abort during actual native IO refuses bytes and close drains the owned descriptor", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const file = openCheckpointSourceFile(f.directory, "file", f.custody, { signal: abort.signal, check() {} });
  try {
    const reading = file.read();
    abort.abort(new Error("capture purged"));
    await expect(reading).rejects.toThrow("capture purged");
    await file.close();
    expect(ownedDescriptors([f.path, join(f.path, "file")])).toEqual([f.directory.descriptor]);
  } finally {
    await file.close();
    await f.close();
  }
});

test("close drains an active read and refuses before touching a reused native descriptor", async () => {
  const f = await fixture();
  const file = openCheckpointSourceFile(f.directory, "file", f.custody, { check() {} });
  const original = file.descriptor;
  try {
    const reading = file.read();
    const settled = reading.then(
      () => "returned bytes",
      (error: Error) => error.message,
    );
    await file.close();
    expect(await settled).toContain("closed");
    const replacement = openSync(join(f.path, "file"), constants.O_RDONLY);
    try {
      expect(replacement).toBe(original);
      await expect(file.read()).rejects.toThrow("closed");
      await file.close();
      expect(fstatSync(replacement).isFile()).toBe(true);
    } finally {
      closeSync(replacement);
    }
  } finally {
    await file.close();
    await f.close();
  }
});

test("FIFO refusal keeps its no-leak proof when another real descriptor owner closes", async () => {
  const f = await fixture();
  f.directory.close();
  expect(Bun.spawnSync(["mkfifo", join(f.path, "unsafe")]).exitCode).toBe(0);
  const directory = openCheckpointDirectory(f.path, () => {});
  let other: number | undefined = openSync(join(f.path, "file"), constants.O_RDONLY);
  try {
    const expected = checkpointCustody(lstatSync(join(f.path, "unsafe"), { bigint: true }));
    expect(() =>
      openCheckpointSourceFile(directory, "unsafe", expected, {
        check() {
          if (other !== undefined) {
            closeSync(other);
            other = undefined;
          }
        },
      }),
    ).toThrow("regular file");
    expect(ownedDescriptors([f.path, join(f.path, "file"), join(f.path, "unsafe")])).toEqual([directory.descriptor]);
  } finally {
    if (other !== undefined) closeSync(other);
    directory.close();
    await f.close();
  }
});
