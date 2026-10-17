import { expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bufferedOutput } from "./buffered-output";

test("buffered output preserves reused source bytes across chunk boundaries and explicit flushes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pc-backup-buffer-"));
  const path = join(directory, "archive");
  const descriptor = openSync(path, "wx", 0o600);
  try {
    const writer = bufferedOutput(descriptor);
    const expected: Buffer[] = [];
    const source = Buffer.alloc(100_003);
    for (const value of [3, 7, 13]) {
      source.fill(value);
      expected.push(Buffer.from(source));
      await writer.append(source);
    }
    await writer.flush();
    expect(await readFile(path)).toEqual(Buffer.concat(expected));
    source.fill(19);
    await writer.append(source.subarray(0, 17));
    source.fill(23);
    await writer.flush();
    await writer.flush();
    expect(await readFile(path)).toEqual(Buffer.concat([...expected, Buffer.alloc(17, 19)]));
  } finally {
    closeSync(descriptor);
    await rm(directory, { recursive: true, force: true });
  }
});
