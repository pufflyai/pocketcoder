import { expect, test } from "bun:test";
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPathCheck } from "./canonical-path";

test("held path custody rejects a renamed ancestor even when its old alias reaches the same inode", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-canonical-")));
  const ancestor = join(root, "original");
  const moved = join(root, "moved");
  const path = join(ancestor, "held");
  mkdirSync(path, { recursive: true });
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  const check = canonicalPathCheck(path, path, descriptor);
  try {
    expect(check()).toBe(true);
    renameSync(ancestor, moved);
    symlinkSync(moved, ancestor);
    expect(check()).toBe(false);
    expect(canonicalPathCheck(path, join(moved, "held"), descriptor)()).toBe(true);
    expect(canonicalPathCheck(path)()).toBe(false);
    expect(canonicalPathCheck(path, join(moved, "held"))()).toBe(true);
  } finally {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});

test("held path custody rejects an unlinked directory and its foreign replacement", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pc-canonical-")));
  const path = join(root, "held");
  mkdirSync(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  const check = canonicalPathCheck(path, path, descriptor);
  try {
    expect(check()).toBe(true);
    rmSync(path, { recursive: true });
    expect(check()).toBe(false);
    mkdirSync(path);
    expect(check()).toBe(false);
  } finally {
    closeSync(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});
