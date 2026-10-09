import { read } from "node:fs";
import { promisify } from "node:util";

const readChunk = promisify(read);

export function createDatabaseFileStreams(descriptor: number, check: () => void) {
  const pending = new Set<Promise<unknown>>();
  let closing = false;
  return {
    stream(size: number) {
      let offset = 0;
      let cancelled = false;
      return new ReadableStream<Uint8Array<ArrayBuffer>>(
        {
          async pull(controller) {
            if (closing) throw new Error("Database export is closed.");
            check();
            if (offset === size) {
              controller.close();
              return;
            }
            const buffer = Buffer.alloc(Math.min(65_536, size - offset));
            const operation = readChunk(descriptor, buffer, 0, buffer.length, offset);
            pending.add(operation);
            try {
              const result = await operation;
              check();
              if (cancelled) return;
              if (closing) throw new Error("Database export closed during its read.");
              if (!result.bytesRead) throw new Error("Sealed database export ended early.");
              offset += result.bytesRead;
              controller.enqueue(buffer.subarray(0, result.bytesRead));
            } finally {
              pending.delete(operation);
            }
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
    },
    async drain() {
      closing = true;
      await Promise.allSettled(pending);
    },
  };
}
