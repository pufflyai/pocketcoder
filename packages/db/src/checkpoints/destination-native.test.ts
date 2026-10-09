import { expect, test } from "bun:test";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destinationFileTime, destinationLinkTime } from "./destination-metadata";
import {
  destinationChmod,
  destinationMkdir,
  destinationOpen,
  destinationReadlink,
  destinationRenameNoReplace,
  destinationStat,
  destinationSymlink,
  destinationUnlink,
} from "./destination-native";

test("native destination operations preserve exact times and clean an owned mode-000 directory without following links", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-native-")));
  const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  let file: number | undefined;
  try {
    destinationMkdir(parent, "owned");
    destinationChmod(parent, "owned", 0);
    expect(destinationStat(parent, "owned").mode & 0o777n).toBe(0n);
    destinationChmod(parent, "owned", 0o700);
    destinationMkdir(parent, "foreign");
    expect(() => destinationRenameNoReplace(parent, "owned", parent, "foreign")).toThrow();
    destinationRenameNoReplace(parent, "owned", parent, "renamed");
    expect(destinationStat(parent, "renamed").isDirectory()).toBe(true);
    file = destinationOpen(parent, "file", constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
    destinationFileTime(file, "1730000000123456789");
    expect(fstatSync(file, { bigint: true }).mtimeNs).toBe(1730000000123456789n);
    destinationSymlink(parent, "link", "file");
    destinationLinkTime(parent, "link", "1730000000987654321");
    expect(destinationStat(parent, "link").isSymbolicLink()).toBe(true);
    expect(destinationStat(parent, "link").mtimeNs).toBe(1730000000987654321n);
    expect(fstatSync(file, { bigint: true }).mtimeNs).toBe(1730000000123456789n);
    expect(destinationReadlink(parent, "link")).toBe("file");
    expect(readlinkSync(join(root, "link"))).toBe("file");
    expect(() => destinationOpen(parent, "link", constants.O_WRONLY)).toThrow();
    expect(() => destinationOpen(parent, "../outside", constants.O_WRONLY)).toThrow();
    expect(() => destinationOpen(parent, "file", constants.O_CREAT | constants.O_EXCL)).toThrow();
    destinationUnlink(parent, "link", false);
    destinationUnlink(parent, "renamed", true);
    destinationUnlink(parent, "foreign", true);
  } finally {
    if (file !== undefined) closeSync(file);
    closeSync(parent);
    try {
      chmodSync(join(root, "owned"), 0o700);
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("nofollow metadata refuses to turn a directory replacement into a target permission change", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pc-destination-mode-")));
  const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await mkdir(join(root, "target"), { mode: 0o700 });
    await writeFile(join(root, "target", "kept"), "unchanged");
    destinationSymlink(parent, "owned", "target");
    expect(() => destinationChmod(parent, "owned", 0)).toThrow();
    expect(lstatSync(join(root, "target")).mode & 0o777).toBe(0o700);
  } finally {
    closeSync(parent);
    await rm(root, { recursive: true, force: true });
  }
});
