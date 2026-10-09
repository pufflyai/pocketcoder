import {
  type CheckpointArchiveHeader,
  type CheckpointArchiveRecord,
  measureCheckpointArchive,
  type PersistenceMount,
  writeCheckpointArchive,
} from "@pstdio/pocketcoder-contracts";
import { createCheckpointCapture } from "@pstdio/pocketcoder-db/checkpoints";
import { ownCheckpointUpload } from "./checkpoint-upload";

interface FilesystemUploadOptions {
  directory: string;
  maxIndexBytes: number;
  maxQueueBytes: number;
  maxArchiveBytes: number;
  signal?: AbortSignal;
  check(): void;
}

export async function createFilesystemCheckpointUpload(
  header: Omit<CheckpointArchiveHeader, "mounts">,
  sources: readonly { root: string; policy: PersistenceMount }[],
  options: FilesystemUploadOptions,
) {
  const capture = await createCheckpointCapture(sources, options);
  try {
    async function* records(): AsyncGenerator<CheckpointArchiveRecord> {
      for await (const entry of capture.entries()) {
        options.signal?.throwIfAborted();
        options.check();
        if (entry.kind === "file") yield { entry, payload: await capture.openPayload(entry) };
        else {
          await capture.validateEntry(entry);
          yield { entry };
        }
      }
    }
    const archive = writeCheckpointArchive({ ...header, mounts: capture.mounts }, records(), {
      maxArchiveBytes: options.maxArchiveBytes,
      signal: options.signal,
    });
    return ownCheckpointUpload(archive, capture, options);
  } catch (error) {
    try {
      await capture.close();
    } catch {
      /* Keep the archive preparation failure after releasing capture ownership. */
    }
    throw error;
  }
}

export async function prepareFilesystemCheckpointUpload(
  identity: Omit<CheckpointArchiveHeader, "mounts">,
  sources: readonly { root: string; policy: PersistenceMount }[],
  options: FilesystemUploadOptions,
) {
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const capture = await createCheckpointCapture(sources, { ...options, signal });
  let consumed = false;
  let closed = false;
  async function close() {
    closed = true;
    abort.abort(new Error("Prepared checkpoint upload is closed."));
    await capture.close();
  }
  try {
    const header = { ...identity, mounts: capture.mounts };
    const archiveBytes = await measureCheckpointArchive(header, capture.entries());
    signal.throwIfAborted();
    options.check();
    if (archiveBytes > options.maxArchiveBytes) throw new Error("Checkpoint archive exceeds its physical reservation.");
    async function* records(): AsyncGenerator<CheckpointArchiveRecord> {
      for await (const entry of capture.entries()) {
        signal.throwIfAborted();
        options.check();
        if (entry.kind === "file") yield { entry, payload: await capture.openPayload(entry) };
        else {
          await capture.validateEntry(entry);
          yield { entry };
        }
      }
    }
    return {
      header,
      archiveBytes,
      upload() {
        if (closed) throw new Error("Prepared checkpoint upload is closed.");
        signal.throwIfAborted();
        options.check();
        if (consumed) throw new Error("Prepared checkpoint upload was already consumed.");
        consumed = true;
        const archive = writeCheckpointArchive(header, records(), { maxArchiveBytes: archiveBytes, signal });
        return ownCheckpointUpload(archive, capture, { ...options, signal });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
