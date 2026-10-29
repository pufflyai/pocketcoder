import {
  type CheckpointArchiveEntry,
  type CheckpointArchiveHeader,
  type CheckpointArchiveRecord,
  validateCheckpointEntryGraph,
  writeCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { createCheckpointEntrySorter } from "@pstdio/pocketcoder-db/checkpoints";

interface UploadOptions {
  directory: string;
  maxIndexBytes: number;
  maxArchiveBytes: number;
  signal?: AbortSignal;
  check(): void;
  openPayload(entry: CheckpointArchiveEntry): Promise<ReadableStream<Uint8Array>>;
}

export function ownCheckpointUpload(
  archive: ReadableStream<Uint8Array>,
  owner: { close(): void | Promise<void> },
  options: Pick<UploadOptions, "signal" | "check">,
) {
  const reader = archive.getReader();
  let closing: Promise<void> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  function check() {
    options.signal?.throwIfAborted();
    options.check();
  }
  function close(reason?: unknown) {
    closing ??= (async () => {
      options.signal?.removeEventListener("abort", abort);
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
        await owner.close();
      }
    })();
    return closing;
  }
  function abort() {
    controller.error(options.signal?.reason);
    void close(options.signal?.reason).catch(() => {});
  }
  return new ReadableStream<Uint8Array>(
    {
      start(value) {
        controller = value;
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      },
      async pull(destination) {
        try {
          check();
          const next = await reader.read();
          check();
          if (next.done) {
            await close();
            destination.close();
          } else destination.enqueue(next.value);
        } catch (error) {
          try {
            await close(error);
          } catch {
            /* Close still releases its owned descriptors. */
          }
          throw error;
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

export async function createCheckpointUpload(
  header: CheckpointArchiveHeader,
  source: AsyncIterable<CheckpointArchiveEntry>,
  options: UploadOptions,
) {
  const sorter = createCheckpointEntrySorter(options.directory, {
    maxBytes: options.maxIndexBytes,
    signal: options.signal,
    check: options.check,
  });
  try {
    for await (const entry of source) await sorter.append(entry);
    const complete = await sorter.seal();
    for await (const entry of complete.entries()) await validateCheckpointEntryGraph(entry, complete.lookup);
    options.signal?.throwIfAborted();
    options.check();
    async function* records(): AsyncGenerator<CheckpointArchiveRecord> {
      for await (const entry of complete.entries()) {
        options.signal?.throwIfAborted();
        options.check();
        if (entry.kind === "file") yield { entry, payload: await options.openPayload(entry) };
        else yield { entry };
      }
    }
    const archive = writeCheckpointArchive(header, records(), {
      maxArchiveBytes: options.maxArchiveBytes,
      signal: options.signal,
    });
    return ownCheckpointUpload(archive, sorter, options);
  } catch (error) {
    try {
      await sorter.close();
    } catch {
      /* Keep the preparation failure while releasing its files. */
    }
    throw error;
  }
}
