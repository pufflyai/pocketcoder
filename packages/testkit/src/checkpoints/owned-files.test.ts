import { expect, test } from "bun:test";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descriptorPath, trackCheckpointFiles } from "./owned-files";

test("a descriptor closed after inventory has no path to adopt", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-closed-fd-")));
  try {
    const fd = openSync(join(root, "closed"), "wx+");
    closeSync(fd);
    expect(descriptorPath(fd)).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint ownership follows native identities through unrelated closure and FD reuse", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-owned-files-")));
  const stage = join(root, "stage");
  mkdirSync(stage);
  const handles = new Set<number>();
  function anonymous(path: string) {
    const fd = openSync(path, "wx+");
    handles.add(fd);
    unlinkSync(path);
    writeSync(fd, "data");
    return fd;
  }
  function close(fd: number) {
    closeSync(fd);
    handles.delete(fd);
  }
  try {
    const previous = anonymous(join(root, "previous"));
    const owned = trackCheckpointFiles(stage);
    const file = anonymous(join(stage, "owned"));
    const later = anonymous(join(root, "later"));
    const parent = openSync(stage, "r");
    handles.add(parent);
    expect(owned.snapshot()).toHaveLength(2);
    expect(owned.files().map(({ stat }) => stat.size)).toEqual([4n]);
    close(previous);
    expect(owned.snapshot()).toHaveLength(2);
    close(file);
    const replacement = anonymous(join(root, "replacement"));
    expect(owned.files()).toEqual([]);
    close(parent);
    expect(owned.snapshot()).toEqual([]);
    for (const fd of [later, replacement]) {
      expect(fstatSync(fd).size).toBe(4);
      const bytes = Buffer.alloc(4);
      expect(readSync(fd, bytes, 0, 4, 0)).toBe(4);
      expect(bytes.toString()).toBe("data");
    }
  } finally {
    for (const fd of handles) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
