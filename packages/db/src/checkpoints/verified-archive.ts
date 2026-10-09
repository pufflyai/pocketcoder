import { type CheckpointArchiveHeader, readCheckpointArchive } from "@pstdio/pocketcoder-contracts";
import { createCheckpointArchiveSpool } from "./archive-spool";
import { createCheckpointEntryIndex } from "./entry-index";
import { validateCheckpointIndexGraph } from "./index-graph";

export interface VerifiedCheckpointArchiveOptions {
  directory: string;
  maxArchiveBytes: number;
  maxIndexBytes: number;
  maxAllocatedBytes?: number;
  signal?: AbortSignal;
  check(): void;
  authorizeHeader(header: CheckpointArchiveHeader): Promise<void>;
}

export async function createVerifiedCheckpointArchive(
  source: ReadableStream<Uint8Array>,
  options: VerifiedCheckpointArchiveOptions,
) {
  let closed = false;
  let cleaning = false;
  let closing: Promise<void> | undefined;
  let spool: ReturnType<typeof createCheckpointArchiveSpool> | undefined;
  let constructionDrain: Promise<void> | undefined;
  let index: ReturnType<typeof createCheckpointEntryIndex> | undefined;
  function state() {
    options.signal?.throwIfAborted();
    if (closed) throw new Error("Verified checkpoint archive is closed.");
  }
  function check() {
    // Cleanup drops admission authority; held files still perform native custody checks.
    if (cleaning) return;
    state();
    options.check();
    if (
      options.maxAllocatedBytes !== undefined &&
      (spool?.allocatedBytes ?? 0) + (index?.allocatedBytes ?? 0) > options.maxAllocatedBytes
    )
      throw new Error("Verified checkpoint archive exceeds its allocated reservation.");
    state();
  }
  function close(reason?: unknown) {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      // Let synchronous constructors publish ownership before cleanup snapshots it.
      await Promise.resolve();
      cleaning = true;
      const results = await Promise.allSettled([spool?.close(reason), index?.close()]);
      options.signal?.removeEventListener("abort", abort);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    })();
    return closing;
  }
  const abort = () => {
    void close(options.signal?.reason).catch(() => {});
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    check();
    spool = createCheckpointArchiveSpool(source, {
      directory: options.directory,
      maxBytes: options.maxArchiveBytes,
      signal: options.signal,
      check,
      onConstructionFailure(draining) {
        constructionDrain = draining;
      },
    });
    index = createCheckpointEntryIndex(options.directory, {
      maxBytes: options.maxIndexBytes,
      signal: options.signal,
      check,
    });
    const receivingIndex = index;
    const archive = await readCheckpointArchive(spool.stream, {
      maxArchiveBytes: options.maxArchiveBytes,
      signal: options.signal,
      async onHeader(header) {
        check();
        await options.authorizeHeader(header);
        check();
      },
      onEntry: (entry) => receivingIndex.append(entry),
      async onData() {
        check();
      },
      async onEntryComplete() {
        check();
      },
    });
    spool.seal();
    const complete = index.seal();
    await validateCheckpointIndexGraph(complete, check);
    const heldSpool = spool;
    function validate() {
      state();
      check();
      state();
      heldSpool.validate();
      complete.validate();
      state();
    }
    validate();
    if (archive.archiveBytes !== spool.bytes) throw new Error("Verified checkpoint raw size changed.");
    for (const mount of archive.header.mounts) Object.freeze(mount);
    Object.freeze(archive.header.mounts);
    Object.freeze(archive.header);
    for (const mount of archive.summary.mounts) Object.freeze(mount);
    Object.freeze(archive.summary.mounts);
    Object.freeze(archive.summary);
    const receipt = Object.freeze({
      ...archive,
      entryCount: complete.count,
      indexBytes: index.bytes,
      allocatedBytes: spool.allocatedBytes + index.allocatedBytes,
    });
    async function lookup(mount: number, path: string) {
      validate();
      const entry = await complete.lookup(mount, path);
      validate();
      return entry;
    }
    async function ordinal(mount: number, path: string) {
      validate();
      const result = await complete.ordinal(mount, path);
      validate();
      return result;
    }
    async function entryAt(ordinal: number) {
      validate();
      const entry = await complete.entryAt(ordinal);
      validate();
      return entry;
    }
    async function* entries(options: { reverse?: boolean } = {}) {
      validate();
      for await (const entry of complete.entries(options)) {
        validate();
        yield entry;
      }
      validate();
    }
    return {
      receipt,
      lookup,
      ordinal,
      entryAt,
      entries,
      replay() {
        validate();
        return heldSpool.replay();
      },
      validate,
      close,
    };
  } catch (error) {
    await close(error).catch(() => {});
    await constructionDrain?.catch(() => {});
    if (!spool && !constructionDrain) {
      try {
        await source.cancel(error);
      } catch {
        /* Preserve the construction refusal. */
      }
    }
    throw error;
  }
}

export type VerifiedCheckpointArchive = Awaited<ReturnType<typeof createVerifiedCheckpointArchive>>;
