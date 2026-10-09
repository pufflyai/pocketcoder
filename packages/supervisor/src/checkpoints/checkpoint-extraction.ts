import { canonicalJson, readCheckpointArchive } from "@pstdio/pocketcoder-contracts";
import type { createCheckpointDestination, createVerifiedCheckpointArchive } from "@pstdio/pocketcoder-db/checkpoints";

type Archive = Awaited<ReturnType<typeof createVerifiedCheckpointArchive>>;
type Destination = Awaited<ReturnType<typeof createCheckpointDestination>>;

interface ExtractionOptions {
  signal?: AbortSignal;
  check(): void;
}

export async function extractVerifiedCheckpoint(
  archive: Archive,
  destination: Destination,
  options: ExtractionOptions,
) {
  let ordinal = 0;
  let active: Awaited<ReturnType<Destination["openFile"]>> | undefined;
  function check() {
    options.signal?.throwIfAborted();
    options.check();
    options.signal?.throwIfAborted();
    archive.validate();
    destination.validate();
  }
  try {
    const replay = await readCheckpointArchive(archive.replay(), {
      maxArchiveBytes: archive.receipt.archiveBytes,
      signal: options.signal,
      async onHeader(header) {
        check();
        if (canonicalJson(header) !== canonicalJson(archive.receipt.header))
          throw new Error("Checkpoint replay header changed.");
      },
      async onEntry(entry) {
        check();
        const expected = await archive.entryAt(ordinal++);
        check();
        if (canonicalJson(entry) !== canonicalJson(expected)) throw new Error("Checkpoint replay entry changed.");
        if (entry.kind === "directory") await destination.createDirectory(entry);
        if (entry.kind === "file") active = await destination.openFile(entry);
        check();
      },
      async onData(_entry, bytes) {
        check();
        if (!active) throw new Error("Checkpoint replay has no active file.");
        await active.write(bytes);
        check();
      },
      async onEntryComplete(entry) {
        check();
        if (entry.kind === "file") {
          if (!active) throw new Error("Checkpoint completed file is missing.");
          await active.finish();
          active = undefined;
        }
        check();
      },
    });
    check();
    if (
      ordinal !== archive.receipt.entryCount ||
      replay.archiveDigest !== archive.receipt.archiveDigest ||
      canonicalJson(replay.summary) !== canonicalJson(archive.receipt.summary)
    )
      throw new Error("Checkpoint replay receipt changed.");
    for await (const entry of archive.entries()) {
      check();
      if (entry.kind === "symlink") await destination.createLink(entry);
      check();
    }
    await destination.census();
    check();
    // The destination owns metadata finalization and the last physical census.
    const mounts = await destination.preparedMounts();
    options.signal?.throwIfAborted();
    return Object.freeze(mounts.map((mount) => Object.freeze(mount)));
  } catch (error) {
    try {
      await active?.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Checkpoint file failed; cleanup requires owned reconciliation.", {
        cause: error,
      });
    }
    throw error;
  }
}
