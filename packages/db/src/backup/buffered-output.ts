import { write as writeCallback } from "node:fs";
import { promisify } from "node:util";
import { CHUNK_BYTES } from "./file-chunks";

const write = promisify(writeCallback);

// Tar headers and padding are small. Batch them with content in one bounded buffer.
export function bufferedOutput(file: number) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let used = 0;
  async function flush() {
    for (let done = 0; done < used; ) done += (await write(file, buffer, done, used - done)).bytesWritten;
    used = 0;
  }
  return {
    async append(bytes: Uint8Array) {
      for (let offset = 0; offset < bytes.length; ) {
        const length = Math.min(buffer.length - used, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + length), used);
        used += length;
        offset += length;
        if (used === buffer.length) await flush();
      }
    },
    flush,
  };
}
