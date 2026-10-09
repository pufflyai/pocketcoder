import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointArchivePublication } from "./archive-publication";
import { removeInterruptedCheckpointPublication } from "./archive-recovery";

test.each(["replacement", "link", "unrecorded"])("restart keeps %s files and their charge pending", async (kind) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-owned-recovery-")));
  const name = `${randomUUID()}-${randomUUID()}.tar`;
  const partial = `.${name}.partial`;
  const owner = createCheckpointArchivePublication(directory, name, () => {});
  const identity = owner.identity();
  const kept = join(directory, "kept");
  try {
    await rename(join(directory, partial), kept);
    if (kind === "link") await symlink(kept, join(directory, partial));
    else await writeFile(join(directory, partial), "replacement", { mode: 0o600 });
    expect(() =>
      removeInterruptedCheckpointPublication(directory, name, kind === "unrecorded" ? null : identity),
    ).toThrow();
    expect(await readFile(join(directory, partial), "utf8")).toBe(kind === "link" ? "" : "replacement");
    await rm(join(directory, partial));
    await rename(kept, join(directory, partial));
    const check = removeInterruptedCheckpointPublication(directory, name, identity);
    check();
    await writeFile(join(directory, partial), "reappeared");
    expect(check).toThrow();
  } finally {
    await owner.close(true).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart removes the same recorded inode after partial writes", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "pc-written-recovery-")));
  const name = `${randomUUID()}-${randomUUID()}.tar`;
  const partial = join(directory, `.${name}.partial`);
  const owner = createCheckpointArchivePublication(directory, name, () => {});
  const identity = owner.identity();
  try {
    await writeFile(partial, "partial upload", { mode: 0o600 });
    expect(String(statSync(partial, { bigint: true }).ino)).toBe(identity.inode);
    // Keep another descriptor open as a process would until SIGKILL.
    const held = openSync(partial, "r");
    try {
      removeInterruptedCheckpointPublication(directory, name, identity)();
    } finally {
      closeSync(held);
    }
  } finally {
    await owner.close(true).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
