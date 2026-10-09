import { createHash } from "node:crypto";
import { CHECKPOINT_IO_BYTES } from "./archive-format";

export function checkpointInput(source: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid checkpoint archive reservation.");
  const reader = source.getReader();
  const hash = createHash("sha256");
  let chunk: Uint8Array = new Uint8Array(0);
  let used = 0;
  let bytes = 0;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = reader.cancel(signal?.reason);
    void cancellation.catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  async function nextChunk() {
    signal?.throwIfAborted();
    while (used === chunk.length) {
      const next = await reader.read();
      signal?.throwIfAborted();
      if (next.done) return false;
      chunk = next.value;
      used = 0;
    }
    return true;
  }
  return {
    get bytes() {
      return bytes;
    },
    digest: () => `sha256:${hash.digest("hex")}`,
    async read(size: number) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(size) || size < 0 || size > CHECKPOINT_IO_BYTES)
        throw new Error("Invalid checkpoint read size.");
      if (!Number.isSafeInteger(bytes + size) || bytes + size > maxBytes)
        throw new Error("Checkpoint archive exceeds its physical reservation.");
      const result = Buffer.alloc(size);
      let copied = 0;
      while (copied < size) {
        if (!(await nextChunk())) throw new Error("Truncated checkpoint archive.");
        const length = Math.min(size - copied, chunk.length - used);
        result.set(chunk.subarray(used, used + length), copied);
        used += length;
        copied += length;
      }
      bytes += size;
      hash.update(result);
      return result;
    },
    async end() {
      if (await nextChunk()) throw new Error("Checkpoint archive has trailing data.");
    },
    async close() {
      signal?.removeEventListener("abort", abort);
      try {
        await (cancellation ?? reader.cancel());
      } finally {
        reader.releaseLock();
      }
    },
  };
}
