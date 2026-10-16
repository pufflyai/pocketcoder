import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function verifyProjectionFile(path: string, size: number, digest: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) throw new Error("Invalid input projection file.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (!bytesRead) throw new Error("Truncated input projection.");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (`sha256:${hash.digest("hex")}` !== digest) throw new Error("Input projection digest mismatch.");
  } finally {
    await file.close();
  }
}

export async function writeProjectionFile(path: string, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const file = await open(path, "wx", 0o444);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await file.writeFile(value);
    }
    await file.sync();
  } finally {
    await file.close();
    await reader.cancel();
    reader.releaseLock();
  }
}
