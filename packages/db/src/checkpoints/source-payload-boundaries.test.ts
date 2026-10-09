import { expect, test } from "bun:test";
import { fstatSync, lstatSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCheckpointDirectory } from "./directory-reader";
import { checkpointCustody } from "./source-custody";
import { openCheckpointSourceFile } from "./source-file";
import { createCheckpointSourcePayload } from "./source-payload";

async function fixture(size = 130_049) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "pc-source-payload-")));
  const bytes = Buffer.alloc(size, 31);
  writeFileSync(join(path, "file"), bytes);
  const parent = openCheckpointDirectory(path, () => {});
  const file = openCheckpointSourceFile(
    parent,
    "file",
    checkpointCustody(lstatSync(join(path, "file"), { bigint: true })),
    { check() {} },
  );
  return {
    path,
    bytes,
    parent,
    file,
    async close() {
      await file.close();
      parent.close();
      await rm(path, { recursive: true, force: true });
    },
  };
}

test.each(["abort", "close"])("post-read check can %s without delivering native bytes", async (mode) => {
  const f = await fixture();
  const abort = new AbortController();
  let checks = 0;
  let closed = 0;
  const reason = new Error("post read capture ended");
  const payload = createCheckpointSourcePayload(f.file, {
    signal: abort.signal,
    check() {
      if (++checks !== 2) return;
      if (mode === "abort") abort.abort(reason);
      else void payload.close(reason);
    },
    onClose() {
      closed++;
      f.parent.close();
    },
  });
  const reader = payload.stream.getReader();
  try {
    await expect(reader.read()).rejects.toThrow("post read capture ended");
    await payload.close();
    expect(checks).toBe(2);
    expect(closed).toBe(1);
    expect(() => fstatSync(f.file.descriptor)).toThrow();
  } finally {
    await payload.close();
    reader.releaseLock();
    await f.close();
  }
});

test("external close wakes EOF reader while parent cleanup is still draining", async () => {
  const f = await fixture(0);
  let started!: () => void;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = 0;
  const payload = createCheckpointSourcePayload(f.file, {
    check() {},
    async onClose() {
      started();
      await released;
      closed++;
      f.parent.close();
    },
  });
  const reader = payload.stream.getReader();
  const reading = reader.read();
  void reading.catch(() => {});
  try {
    await cleanup;
    expect(() => fstatSync(f.file.descriptor)).toThrow();
    const closing = payload.close(new Error("EOF cleanup interrupted"));
    await expect(reading).rejects.toThrow("EOF cleanup interrupted");
    expect(closed).toBe(0);
    release();
    await closing;
    expect(closed).toBe(1);
  } finally {
    release();
    await payload.close();
    reader.releaseLock();
    await f.close();
  }
});
