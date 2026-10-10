import { read as readCallback } from "node:fs";
import { promisify } from "node:util";

const read = promisify(readCallback);

export const CHUNK_BYTES = 65_536;

// Reads exactly `size` bytes through one reused buffer, so memory stays flat for large members.
// Each chunk is only valid until the caller asks for the next one.
export async function* fileChunks(file: number, size: number, check: () => void, start = 0) {
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size));
  for (let offset = 0; offset < size; ) {
    check();
    const { bytesRead } = await read(file, buffer, 0, Math.min(buffer.length, size - offset), start + offset);
    if (!bytesRead) throw new Error("Backup source ended early.");
    offset += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
