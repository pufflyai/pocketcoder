import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import { createCheckpointDestination, createVerifiedCheckpointArchive } from "@pstdio/pocketcoder-db/checkpoints";
import { extractVerifiedCheckpoint } from "./checkpoint-extraction";
import {
  authorizeCheckpointDownload,
  type CheckpointDownloadBinding,
  type CheckpointDownloadMount,
} from "./download-authority";

interface FilesystemDownloadOptions {
  directory: string;
  maxArchiveBytes: number;
  maxIndexBytes: number;
  maxLedgerBytes: number;
  signal?: AbortSignal;
  check(): void;
}

export async function createFilesystemCheckpointDownload(
  source: ReadableStream<Uint8Array>,
  binding: CheckpointDownloadBinding,
  mounts: readonly CheckpointDownloadMount[],
  options: FilesystemDownloadOptions,
) {
  const admitted = Object.freeze({
    source: Object.freeze({ ...binding.source }),
    destination: Object.freeze({ ...binding.destination }),
  });
  const admittedMounts = Object.freeze(
    mounts.map((mount) =>
      Object.freeze({
        parent: mount.parent,
        policy: Object.freeze({ ...mount.policy }),
      }),
    ),
  );
  const settings = { ...options };
  const abort = new AbortController();
  const signal = settings.signal ? AbortSignal.any([settings.signal, abort.signal]) : abort.signal;
  let archive: Awaited<ReturnType<typeof createVerifiedCheckpointArchive>> | undefined;
  let destination: Awaited<ReturnType<typeof createCheckpointDestination>> | undefined;
  let receiving = false;
  let closed = false;
  let closing: Promise<void> | undefined;
  function check() {
    signal.throwIfAborted();
    settings.check();
    signal.throwIfAborted();
  }
  function close(reason?: unknown) {
    closing ??= (async () => {
      closed = true;
      signal.removeEventListener("abort", aborted);
      // Cleanup owns its ledger and completes before the retained archive/index is released.
      const results = await Promise.allSettled([destination?.close(reason)]);
      abort.abort(reason ?? new Error("Prepared checkpoint is closed."));
      results.push(...(await Promise.allSettled([archive?.close(reason)])));
      const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (errors.length) throw new AggregateError(errors, "Checkpoint cleanup requires owned reconciliation.");
    })();
    return closing;
  }
  function aborted() {
    void close(signal.reason).catch(() => {});
  }
  try {
    check();
    receiving = true;
    archive = await createVerifiedCheckpointArchive(source, {
      ...settings,
      signal,
      async authorizeHeader(header) {
        check();
        authorizeCheckpointDownload(header, admitted, admittedMounts);
        check();
      },
    });
    check();
    const verified = archive;
    if (verified.receipt.archiveDigest !== admitted.source.archiveDigest)
      throw new Error("Checkpoint archive digest does not match the recorded source.");
    destination = await createCheckpointDestination(
      admittedMounts,
      {
        count: verified.receipt.entryCount,
        ordinal: verified.ordinal,
        entryAt: verified.entryAt,
      },
      { directory: settings.directory, maxCustodyBytes: settings.maxLedgerBytes, signal, check },
    );
    check();
    const target = destination;
    const preparedMounts = await extractVerifiedCheckpoint(verified, target, { signal, check });
    signal.throwIfAborted();
    signal.addEventListener("abort", aborted, { once: true });
    return Object.freeze({
      binding: admitted,
      receipt: verified.receipt,
      mounts: preparedMounts,
      validate() {
        if (closed) throw new Error("Prepared checkpoint is closed.");
        check();
        verified.validate();
        target.validate();
      },
      async verify() {
        if (closed) throw new Error("Prepared checkpoint is closed.");
        check();
        verified.validate();
        target.validate();
        // All caller callbacks precede the final native graph proof.
        const current = await target.preparedMounts();
        if (closed) throw new Error("Prepared checkpoint is closed.");
        signal.throwIfAborted();
        if (canonicalJson(current) !== canonicalJson(preparedMounts))
          throw new Error("Prepared checkpoint mount identities changed.");
      },
      async publish() {
        if (closed) throw new Error("Prepared checkpoint is closed.");
        check();
        verified.validate();
        const mounts = await target.publish();
        return mounts;
      },
      close,
    });
  } catch (error) {
    if (!receiving) {
      try {
        await source.cancel(error);
      } catch {
        /* Keep the admission refusal after upstream cancellation. */
      }
    }
    try {
      await close(error);
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Checkpoint download failed; cleanup requires owned reconciliation.", {
        cause: error,
      });
    }
    throw error;
  }
}
