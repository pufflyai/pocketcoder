import { expect, test } from "bun:test";
import { fstatSync, lstatSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCheckpointDirectory } from "./directory-reader.ts";
import { checkpointCustody } from "./source-custody.ts";
import { openCheckpointSourceFile } from "./source-file.ts";
import { createCheckpointSourcePayload } from "./source-payload.ts";
import { createVerifiedCheckpointArchive } from "./verified-archive.ts";

test.each([false, true])(
  "construction refusal drains native cancellation even when cleanup rejects: %s",
  async (rejectCleanup) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pc-archive-cancel-review-")));
    const source = join(root, "source");
    const scratch = join(root, "scratch");
    await mkdir(source);
    await mkdir(scratch, { mode: 0o700 });
    await chmod(scratch, 0o755);
    writeFileSync(join(source, "body"), "actual native source bytes");
    const parent = openCheckpointDirectory(source, () => {});
    const original = lstatSync(join(source, "body"), { bigint: true });
    const file = openCheckpointSourceFile(parent, "body", checkpointCustody(original), { check() {} });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const draining = new Promise<void>((resolve) => {
      started = resolve;
    });
    const payload = createCheckpointSourcePayload(file, {
      check() {},
      async onClose() {
        started();
        await gate;
        parent.close();
        if (rejectCleanup) throw new Error("native cancellation failed");
      },
    });
    let settled = false;
    const result = createVerifiedCheckpointArchive(payload.stream, {
      directory: scratch,
      maxArchiveBytes: 1000,
      maxIndexBytes: 1000,
      check() {},
      async authorizeHeader() {},
    });
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await draining;
      await Bun.sleep(0);
      expect(settled).toBe(false);
      release();
      await expect(result).rejects.toThrow("mode 0700");
      expect(payload.stream.locked).toBe(false);
      expect(() => fstatSync(parent.descriptor)).toThrow();
    } finally {
      release();
      await result.catch(() => {});
      await payload.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  },
);
