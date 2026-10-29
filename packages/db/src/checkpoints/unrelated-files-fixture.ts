import { afterEach, beforeEach, expect } from "bun:test";
import {
  closeSync,
  fstatSync,
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

export function unrelatedFilesFixture() {
  let root: string;
  let files: { fd: number; bytes: Buffer }[];
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pc-unrelated-")));
    files = [4, 8].map((size) => {
      const path = join(root, String(size));
      const fd = openSync(path, "wx+");
      unlinkSync(path);
      const bytes = Buffer.alloc(size, 37);
      writeSync(fd, bytes);
      return { fd, bytes };
    });
  });
  afterEach(() => {
    try {
      for (const { fd, bytes } of files) {
        expect(fstatSync(fd).size).toBe(bytes.length);
        const actual = Buffer.alloc(bytes.length);
        expect(readSync(fd, actual, 0, actual.length, 0)).toBe(bytes.length);
        expect(actual.equals(bytes)).toBe(true);
      }
    } finally {
      for (const { fd } of files) closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
