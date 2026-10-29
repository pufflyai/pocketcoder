import { expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackCheckpointFiles } from "@pstdio/pocketcoder-testkit";
import { createCheckpointArchiveSpool } from "./archive-spool";
import { unrelatedFilesFixture } from "./unrelated-files-fixture";

async function directory() {
  return realpath(await mkdtemp(join(tmpdir(), "pc-archive-spool-")));
}

test("anonymous spool keeps exact sealed bytes and one bounded replay until cached close", async () => {
  const root = await directory();
  const bytes = Buffer.alloc(140_000, 41);
  const source = new Blob([bytes]).stream();
  const spool = createCheckpointArchiveSpool(source, { directory: root, maxBytes: bytes.length, check() {} });
  try {
    expect(Buffer.from(await new Response(spool.stream).arrayBuffer())).toEqual(bytes);
    expect(spool.bytes).toBe(bytes.length);
    expect(await readdir(root)).toEqual([]);
    spool.seal();
    const replay = spool.replay();
    expect(() => spool.replay()).toThrow("consumer");
    expect(Buffer.from(await new Response(replay).arrayBuffer())).toEqual(bytes);
    const close = spool.close();
    expect(spool.close()).toBe(close);
    await close;
    expect(() => spool.replay()).toThrow("closed");
    expect(source.locked).toBe(false);
  } finally {
    await spool.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("close before consumption and while an original read is waiting wakes and releases ownership", async () => {
  for (const consume of [false, true]) {
    const root = await directory();
    let canceled = false;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++;
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const spool = createCheckpointArchiveSpool(source, { directory: root, maxBytes: 1024, check() {} });
    const reader = spool.stream.getReader();
    try {
      const pending = consume
        ? reader.read().then(
            () => "resolved",
            (error: Error) => error.message,
          )
        : undefined;
      if (consume) while (!pulls) await Bun.sleep(0);
      await spool.close(new Error("closed by owner"));
      if (pending) expect(await pending).toContain("closed by owner");
      expect(canceled).toBe(true);
      expect(source.locked).toBe(false);
      expect(await readdir(root)).toEqual([]);
    } finally {
      reader.releaseLock();
      await spool.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("physical reservation refuses input before excess writes", async () => {
  for (const [length, budget, reason] of [[1024, 1023, "reservation"]] as const) {
    const root = await directory();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(length));
        controller.close();
      },
    });
    const spool = createCheckpointArchiveSpool(source, { directory: root, maxBytes: budget, check() {} });
    try {
      await expect(new Response(spool.stream).arrayBuffer()).rejects.toThrow(reason);
      expect(spool.bytes).toBe(0);
    } finally {
      await spool.close();
      expect(source.locked).toBe(false);
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("failed post-native write retains the actual allocated byte count until close", async () => {
  const root = await directory();
  const owned = trackCheckpointFiles(root);
  let actual = 0;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.alloc(65_536, 23));
      controller.close();
    },
  });
  const spool = createCheckpointArchiveSpool(source, {
    directory: root,
    maxBytes: 65_536,
    check() {
      actual = owned.files().reduce((sum, { stat }) => sum + Number(stat.size), 0);
      if (actual) throw new Error("native authority refused");
    },
  });
  try {
    await expect(new Response(spool.stream).arrayBuffer()).rejects.toThrow("native authority refused");
    expect(actual).toBe(65_536);
    expect(owned.snapshot()).toHaveLength(2);
    expect(spool.bytes).toBe(actual);
  } finally {
    await spool.close().catch(() => {});
    expect(owned.snapshot()).toHaveLength(0);
    await rm(root, { recursive: true, force: true });
  }
});

unrelatedFilesFixture();
