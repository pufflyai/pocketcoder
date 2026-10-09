import { expect, test } from "bun:test";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCheckpointDirectory } from "./directory-reader";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "checkpoint-reader-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function descriptors() {
  return readdirSync("/dev/fd").length;
}

test("native directory iteration reads a wide real directory one name at a time", async () => {
  await fixture(async (root) => {
    for (let i = 0; i < 2048; i++) writeFileSync(join(root, `file-${i}`), "");
    const baseline = descriptors();
    const directory = openCheckpointDirectory(root, () => {});
    try {
      expect(descriptors()).toBe(baseline + 1);
      const names = new Set<string>();
      let name = directory.read();
      while (name !== undefined) {
        names.add(name);
        name = directory.read();
      }
      expect(names.size).toBe(2048);
      expect(names.has("file-2047")).toBe(true);
      expect(names.has(".")).toBe(false);
      expect(names.has("..")).toBe(false);
    } finally {
      directory.close();
    }
    expect(descriptors()).toBe(baseline);
  });
});

test("directory custody refuses final and ancestor symlinks without leaking descriptors", async () => {
  await fixture(async (root) => {
    mkdirSync(join(root, "real"));
    mkdirSync(join(root, "real", "child"));
    await symlink("real", join(root, "alias"));
    const baseline = descriptors();
    expect(() => openCheckpointDirectory(join(root, "alias"), () => {})).toThrow();
    expect(() => openCheckpointDirectory(join(root, "alias", "child"), () => {})).toThrow();
    expect(descriptors()).toBe(baseline);
  });
});

test("a real namespace mutation invalidates the held directory before the next name", async () => {
  await fixture(async (root) => {
    writeFileSync(join(root, "first"), "");
    const directory = openCheckpointDirectory(root, () => {});
    try {
      expect(directory.read()).toBe("first");
      writeFileSync(join(root, "late"), "");
      expect(() => directory.read()).toThrow("changed");
    } finally {
      directory.close();
    }
  });
});

test("renaming the actual held parent invalidates its canonical custody", async () => {
  await fixture(async (root) => {
    const child = join(root, "child");
    mkdirSync(child);
    const directory = openCheckpointDirectory(child, () => {});
    try {
      renameSync(child, join(root, "moved"));
      mkdirSync(child);
      expect(() => directory.read()).toThrow("changed");
    } finally {
      directory.close();
    }
  });
});

test("unsafe real filenames are refused before they become archive paths", async () => {
  await fixture(async (root) => {
    writeFileSync(join(root, "bad\\name"), "");
    const directory = openCheckpointDirectory(root, () => {});
    try {
      expect(() => directory.read()).toThrow("Unsafe");
    } finally {
      directory.close();
    }
  });
});

test("closed readers refuse before touching a reused native descriptor", async () => {
  await fixture(async (root) => {
    const directory = openCheckpointDirectory(root, () => {});
    const original = directory.descriptor;
    directory.close();
    const replacement = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(replacement).toBe(original);
      expect(() => directory.read()).toThrow("closed");
      directory.close();
      expect(fstatSync(replacement).isDirectory()).toBe(true);
    } finally {
      closeSync(replacement);
    }
  });
});

test("close from an authority check refuses even when the actual descriptor is reused", async () => {
  await fixture(async (root) => {
    let armed = false;
    let replacement: number | undefined;
    const directory = openCheckpointDirectory(root, () => {
      if (!armed) return;
      armed = false;
      directory.close();
      replacement = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    });
    try {
      armed = true;
      expect(() => directory.validate()).toThrow("closed");
      expect(replacement).toBe(directory.descriptor);
      if (replacement === undefined) throw new Error("Expected real replacement descriptor");
      expect(fstatSync(replacement).isDirectory()).toBe(true);
    } finally {
      directory.close();
      if (replacement !== undefined) closeSync(replacement);
    }
  });
});
