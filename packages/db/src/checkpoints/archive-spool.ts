import { fstatSync, write } from "node:fs";
import { createBackupFile } from "../database/backup-native-file";

interface ArchiveReplay {
  reader: {
    read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
  controller: ReadableStreamDefaultController<Uint8Array>;
  pending?: Promise<void>;
  released: boolean;
}

interface SpoolOptions {
  directory: string;
  maxBytes: number;
  signal?: AbortSignal;
  check(): void;
  onConstructionFailure?(draining: Promise<void>): void;
}

export function createCheckpointArchiveSpool(source: ReadableStream<Uint8Array>, options: SpoolOptions) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
    throw new Error("Invalid checkpoint archive reservation.");
  let closed = false;
  let cleaning = false;
  let complete = false;
  let written = 0;
  let incoming: Uint8Array = new Uint8Array(0);
  let consumed = 0;
  let reads = 0;
  let pending: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let sealed: ReturnType<ReturnType<typeof createBackupFile>["seal"]> | undefined;
  let receiving: ReadableStreamDefaultController<Uint8Array>;
  let replaying: ArchiveReplay | undefined;
  const input = source.getReader();
  let inputReleased = false;
  function state() {
    if (closed) throw new Error("Checkpoint archive spool is closed.");
    options.signal?.throwIfAborted();
  }
  function authority() {
    if (!cleaning) state();
    options.check();
    if (!cleaning) state();
  }
  let file: ReturnType<typeof createBackupFile>;
  try {
    file = createBackupFile(options.directory, authority);
  } catch (error) {
    const draining = input
      .cancel(error)
      .catch(() => {})
      .finally(() => input.releaseLock());
    options.onConstructionFailure?.(draining);
    throw error;
  }
  function validate() {
    state();
    file.validate();
    state();
  }
  async function append(bytes: Buffer) {
    let offset = 0;
    while (offset < bytes.length) {
      validate();
      const count = await new Promise<number>((resolve, reject) => {
        write(file.descriptor, bytes, offset, bytes.length - offset, written, (error, count) =>
          error ? reject(error) : resolve(count),
        );
      }).catch((error) => {
        written = fstatSync(file.descriptor).size;
        throw error;
      });
      written += count;
      offset += count;
      validate();
      if (!count) throw new Error("Checkpoint archive write made no progress.");
    }
  }
  function releaseInput() {
    if (!inputReleased) {
      inputReleased = true;
      input.releaseLock();
    }
  }
  function releaseReplay(current: ArchiveReplay) {
    if (!current.released) {
      current.released = true;
      current.reader.releaseLock();
    }
    if (replaying === current) replaying = undefined;
  }
  function close(reason: unknown = new Error("Checkpoint archive spool is closed.")) {
    if (closing) return closing;
    closed = true;
    receiving.error(reason);
    const current = replaying;
    current?.controller.error(reason);
    const cancellation = inputReleased ? Promise.resolve() : input.cancel(reason);
    const replayCancellation = current?.reader.cancel(reason);
    closing = (async () => {
      try {
        await Promise.allSettled([cancellation, pending, replayCancellation, current?.pending]);
      } finally {
        incoming = new Uint8Array(0);
        releaseInput();
        if (current) releaseReplay(current);
        options.signal?.removeEventListener("abort", abort);
        cleaning = true;
        await file.close();
      }
    })();
    return closing;
  }
  const abort = () => {
    void close(options.signal?.reason).catch(() => {});
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        receiving = controller;
      },
      pull(controller) {
        pending = Promise.resolve().then(async () => {
          validate();
          while (consumed === incoming.length) {
            if (++reads % 64 === 0) await Bun.sleep(0);
            validate();
            const part = await input.read();
            validate();
            if (part.done) {
              complete = true;
              incoming = new Uint8Array(0);
              releaseInput();
              controller.close();
              return;
            }
            incoming = part.value;
            consumed = 0;
          }
          const end = Math.min(incoming.length, consumed + 65_536);
          const size = end - consumed;
          if (!Number.isSafeInteger(written + size) || written + size > options.maxBytes)
            throw new Error("Checkpoint archive exceeds its physical reservation.");
          // Keep one offered slice; copy only the bounded bytes consumed by this pull.
          const bytes = Buffer.from(incoming.subarray(consumed, end));
          await append(bytes);
          validate();
          consumed = end;
          if (consumed === incoming.length) {
            incoming = new Uint8Array(0);
            consumed = 0;
          }
          controller.enqueue(bytes);
        });
        return pending;
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    stream,
    get allocatedBytes() {
      return Number(fstatSync(file.descriptor, { bigint: true }).blocks * 512n);
    },
    get bytes() {
      return written;
    },
    validate,
    seal() {
      validate();
      if (!complete) throw new Error("Checkpoint archive input is incomplete.");
      sealed ??= file.seal();
      if (sealed.size !== written) throw new Error("Checkpoint archive physical size changed.");
      validate();
    },
    replay() {
      validate();
      if (!sealed) throw new Error("Checkpoint archive is not sealed.");
      if (replaying) throw new Error("Checkpoint archive already has a replay consumer.");
      const reader = sealed.stream().getReader();
      let current: ArchiveReplay;
      return new ReadableStream<Uint8Array>(
        {
          start(controller) {
            current = { reader, controller, released: false };
            replaying = current;
          },
          pull(controller) {
            current.pending = Promise.resolve().then(async () => {
              validate();
              const next = await reader.read();
              validate();
              if (next.done) {
                releaseReplay(current);
                controller.close();
              } else controller.enqueue(next.value);
            });
            return current.pending;
          },
          async cancel(reason) {
            await Promise.allSettled([reader.cancel(reason), current.pending]);
            releaseReplay(current);
          },
        },
        { highWaterMark: 0 },
      );
    },
    close,
  };
}
