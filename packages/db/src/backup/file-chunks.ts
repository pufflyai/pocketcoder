import { read as readCallback } from "node:fs";
import { promisify } from "node:util";

const read = promisify(readCallback);

export const CHUNK_BYTES = 65_536;

// Reads exactly `size` bytes in bounded chunks, so memory stays flat for large members.
export async function* fileChunks(file: number, size: number, check: () => void, start = 0) {
  for (let offset = 0; offset < size; ) {
    check();
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset));
    const { bytesRead } = await read(file, buffer, 0, buffer.length, start + offset);
    if (!bytesRead) throw new Error("Backup source ended early.");
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
