import { expect, test } from "bun:test";
import { lstatSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackCheckpointFiles } from "@pstdio/pocketcoder-testkit";
import { openCheckpointDirectory } from "./directory-reader";
import { createCheckpointEntryIndex } from "./entry-index";
import { createCheckpointEntrySorter } from "./entry-sort";
import { checkpointCustody } from "./source-custody";
import { openCheckpointSourceFile } from "./source-file";
import { unrelatedFilesFixture } from "./unrelated-files-fixture";

const entry = (path: string) => ({
  mount: 0,
  path,
  kind: "directory" as const,
  size: 0 as const,
  mode: 448,
  mtime_ns: "0",
});
for (const [name, create] of [
  ["sorter", createCheckpointEntrySorter],
  ["ordered index", createCheckpointEntryIndex],
] as const) {
  test(`${name} charges actual prefix bytes after caller custody refuses`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-physical-review-")));
    const owned = trackCheckpointFiles(root);
    let armed = false;
    const value = create(root, {
      maxBytes: 100000,
      check() {
        if (armed && owned.files().some(({ stat }) => stat.size === 4n)) {
          armed = false;
          throw Error("post prefix fence");
        }
      },
    });
    try {
      armed = true;
      await expect(value.append(entry("a"))).rejects.toThrow("post prefix fence");
      const physical = owned.files().reduce((sum, { stat }) => sum + Number(stat.size), 0);
      expect(physical).toBe(4);
      expect(value.bytes).toBe(physical);
    } finally {
      await value.close();
      expect(owned.snapshot()).toHaveLength(0);
      await rm(root, { recursive: true, force: true });
    }
  });
}
test("sorter charges actual merge target bytes after native write refuses", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-target-review-")));
  const owned = trackCheckpointFiles(root);
  let armed = false;
  const sorter = createCheckpointEntrySorter(root, {
    maxBytes: 100000,
    check() {
      if (armed && owned.files().some(({ stat }) => stat.size === 8n)) {
        armed = false;
        throw Error("post target write fence");
      }
    },
  });
  try {
    await sorter.append(entry("z"));
    await sorter.append(entry("a"));
    armed = true;
    await expect(sorter.seal()).rejects.toThrow("post target write fence");
    const physical = owned.files().reduce((sum, { stat }) => sum + Number(stat.size), 0);
    expect(physical).toBe(184);
    expect(owned.files()).toHaveLength(3);
    expect(sorter.bytes).toBe(physical);
    expect(sorter.peakBytes).toBeGreaterThanOrEqual(physical);
  } finally {
    await sorter.close();
    expect(owned.snapshot()).toHaveLength(0);
    await rm(root, { recursive: true, force: true });
  }
});
test("source close from post-read authority check refuses actually read bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-source-close-review-")));
  writeFileSync(join(root, "file"), Buffer.alloc(65536, 7));
  const parent = openCheckpointDirectory(root, () => {});
  let checks = 0;
  let file: ReturnType<typeof openCheckpointSourceFile> | undefined;
  let closing: Promise<void> | undefined;
  try {
    file = openCheckpointSourceFile(
      parent,
      "file",
      checkpointCustody(lstatSync(join(root, "file"), { bigint: true })),
      {
        check() {
          if (++checks === 4) closing = file?.close();
        },
      },
    );
    await expect(file.read()).rejects.toThrow("closed");
  } finally {
    await closing;
    await file?.close();
    parent.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("source abort from post-read authority check refuses actually read bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-source-abort-review-")));
  writeFileSync(join(root, "file"), Buffer.alloc(65536, 7));
  const parent = openCheckpointDirectory(root, () => {});
  const abort = new AbortController();
  let checks = 0;
  let file: ReturnType<typeof openCheckpointSourceFile> | undefined;
  try {
    file = openCheckpointSourceFile(
      parent,
      "file",
      checkpointCustody(lstatSync(join(root, "file"), { bigint: true })),
      {
        signal: abort.signal,
        check() {
          if (++checks === 4) abort.abort(new Error("post read fence"));
        },
      },
    );
    await expect(file.read()).rejects.toThrow("post read fence");
  } finally {
    await file?.close();
    parent.close();
    await rm(root, { recursive: true, force: true });
  }
});

unrelatedFilesFixture();
