import { expect, test } from "bun:test";
import { closeSync, constants, fstatSync, lstatSync, openSync, writeFileSync } from "node:fs";
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

test("payload has no read ahead, bounded chunks, and closes owned file and parent at EOF", async () => {
  const f = await fixture();
  let reads = 0;
  let closed = 0;
  const payload = createCheckpointSourcePayload(
    {
      ...f.file,
      read() {
        reads++;
        return f.file.read();
      },
    },
    {
      check() {},
      onClose() {
        closed++;
        f.parent.close();
      },
    },
  );
  try {
    await Bun.sleep(1);
    expect(reads).toBe(0);
    const reader = payload.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.length).toBeLessThanOrEqual(65536);
      chunks.push(next.value);
    }
    reader.releaseLock();
    expect(Buffer.concat(chunks)).toEqual(f.bytes);
    expect(closed).toBe(1);
    expect(() => fstatSync(f.file.descriptor)).toThrow();
    await payload.close();
    expect(closed).toBe(1);
  } finally {
    await payload.close();
    await f.close();
  }
});

test.each(["before creation", "without a consumer"])(
  "abort %s drains ownership without starting a native read",
  async (mode) => {
    const f = await fixture();
    const abort = new AbortController();
    if (mode === "before creation") abort.abort(new Error("capture aborted"));
    let reads = 0;
    let closed = 0;
    const payload = createCheckpointSourcePayload(
      {
        ...f.file,
        read() {
          reads++;
          return f.file.read();
        },
      },
      {
        signal: abort.signal,
        check() {},
        onClose() {
          closed++;
          f.parent.close();
        },
      },
    );
    try {
      if (mode === "without a consumer") abort.abort(new Error("capture aborted"));
      await payload.close();
      expect(reads).toBe(0);
      expect(closed).toBe(1);
      expect(() => fstatSync(f.file.descriptor)).toThrow();
      const reader = payload.stream.getReader();
      try {
        await expect(reader.read()).rejects.toThrow("capture aborted");
      } finally {
        reader.releaseLock();
      }
    } finally {
      await payload.close();
      await f.close();
    }
  },
);

test.each(["cancel", "abort", "external close"])(
  "%s settles a locked reader and drains a real active native read before onClose",
  async (mode) => {
    const f = await fixture();
    const abort = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finished = false;
    let closed = 0;
    const payload = createCheckpointSourcePayload(
      {
        ...f.file,
        read() {
          const reading = f.file.read();
          started();
          return reading.finally(() => {
            finished = true;
          });
        },
      },
      {
        signal: abort.signal,
        check() {},
        onClose() {
          expect(finished).toBe(true);
          expect(() => fstatSync(f.file.descriptor)).toThrow();
          closed++;
          f.parent.close();
        },
      },
    );
    const reader = payload.stream.getReader();
    const reading = reader.read();
    void reading.catch(() => {});
    try {
      await active;
      expect(finished).toBe(false);
      const reason = new Error("payload boundary closed");
      if (mode === "cancel") {
        await reader.cancel(reason);
        expect(await reading).toEqual({ done: true, value: undefined });
      } else {
        if (mode === "abort") abort.abort(reason);
        else void payload.close(reason);
        await expect(reading).rejects.toThrow("payload boundary closed");
        await payload.close();
      }
      expect(closed).toBe(1);
      expect(finished).toBe(true);
    } finally {
      await payload.close();
      reader.releaseLock();
      await f.close();
    }
  },
);

test("real file mutation errors the stream and releases file and parent", async () => {
  const f = await fixture();
  let closed = 0;
  const payload = createCheckpointSourcePayload(f.file, {
    check() {},
    onClose() {
      closed++;
      f.parent.close();
    },
  });
  const reader = payload.stream.getReader();
  try {
    const first = await reader.read();
    expect(first.value).toEqual(f.bytes.subarray(0, 65536));
    await Bun.sleep(1);
    writeFileSync(join(f.path, "file"), Buffer.alloc(f.bytes.length, 42));
    await expect(reader.read()).rejects.toThrow("changed");
    await payload.close();
    expect(closed).toBe(1);
    expect(() => fstatSync(f.file.descriptor)).toThrow();
  } finally {
    await payload.close();
    reader.releaseLock();
    await f.close();
  }
});

test("post-await authority refusal never enqueues actually read bytes", async () => {
  const f = await fixture();
  let checks = 0;
  let reads = 0;
  let closed = 0;
  const payload = createCheckpointSourcePayload(
    {
      ...f.file,
      read() {
        reads++;
        return f.file.read();
      },
    },
    {
      check() {
        if (++checks === 2) throw new Error("post read authority fence");
      },
      onClose() {
        closed++;
        f.parent.close();
      },
    },
  );
  const reader = payload.stream.getReader();
  try {
    await expect(reader.read()).rejects.toThrow("post read authority fence");
    await payload.close();
    expect(reads).toBe(1);
    expect(closed).toBe(1);
    expect(() => fstatSync(f.file.descriptor)).toThrow();
  } finally {
    await payload.close();
    reader.releaseLock();
    await f.close();
  }
});

test("EOF cleanup failure refuses success and keeps the same close result", async () => {
  const f = await fixture(0);
  let closed = 0;
  const payload = createCheckpointSourcePayload(f.file, {
    check() {},
    onClose() {
      closed++;
      f.parent.close();
      throw new Error("parent cleanup refused");
    },
  });
  const reader = payload.stream.getReader();
  try {
    await expect(reader.read()).rejects.toThrow("parent cleanup refused");
    const closing = payload.close();
    expect(payload.close()).toBe(closing);
    await expect(closing).rejects.toThrow("parent cleanup refused");
    expect(closed).toBe(1);
    expect(() => fstatSync(f.file.descriptor)).toThrow();
  } finally {
    await payload.close().catch(() => {});
    reader.releaseLock();
    await f.close();
  }
});

test("cached close never touches a reused native descriptor or repeats onClose", async () => {
  const f = await fixture();
  let closed = 0;
  const payload = createCheckpointSourcePayload(f.file, {
    check() {},
    onClose() {
      closed++;
    },
  });
  try {
    const closing = payload.close();
    expect(payload.close()).toBe(closing);
    await closing;
    const replacement = openSync(join(f.path, "file"), constants.O_RDONLY);
    try {
      expect(replacement).toBe(f.file.descriptor);
      await payload.close(new Error("later close"));
      expect(fstatSync(replacement).isFile()).toBe(true);
      expect(closed).toBe(1);
    } finally {
      closeSync(replacement);
    }
  } finally {
    await payload.close();
    await f.close();
  }
});
