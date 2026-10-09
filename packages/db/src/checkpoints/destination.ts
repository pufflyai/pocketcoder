import { closeSync, fstatSync, fsyncSync } from "node:fs";
import type { CheckpointArchiveEntry } from "@pstdio/pocketcoder-contracts";
import { admitDestinationCounts, admitDestinationMounts } from "./destination-admission";
import { drainDestinationClose } from "./destination-close";
import { createDestinationCustody, type DestinationIndex } from "./destination-custody";
import { createDestinationDirectories, type DestinationMount, openDestinationParents } from "./destination-directory";
import { openDestinationFile } from "./destination-file";
import { finalizeDestinationDirectory } from "./destination-finalize";
import { createDestinationInventory } from "./destination-inventory";
import { destinationLinkTime } from "./destination-metadata";
import { destinationMkdir, destinationStat, destinationSymlink } from "./destination-native";
import { publishDestinationMounts } from "./destination-publication";
import { sealDestinationGraph } from "./destination-seal";

interface DestinationOptions {
  directory: string;
  maxCustodyBytes: number;
  signal?: AbortSignal;
  check(): void;
}
export async function createCheckpointDestination(
  requestedMounts: readonly DestinationMount[],
  source: DestinationIndex,
  options: DestinationOptions,
) {
  const mounts = requestedMounts.map(({ parent, policy }) => ({ parent, policy: { ...policy } }));
  let closed = false;
  let cleaning = false;
  let nativePhase = false;
  let published = false;
  function basic() {
    if (cleaning) return;
    if (published) throw new Error("Checkpoint destination is published.");
    if (closed) throw new Error("Checkpoint destination is closed.");
    options.signal?.throwIfAborted();
  }
  function check() {
    basic();
    if (!cleaning && !nativePhase) options.check();
    basic();
  }
  check();
  const scratch = admitDestinationMounts(mounts, options.directory);
  const parents = openDestinationParents(mounts);
  let ledger: Awaited<ReturnType<typeof createDestinationCustody>> | undefined;
  let directories: ReturnType<typeof createDestinationDirectories> | undefined;
  let active: Awaited<ReturnType<typeof openDestinationFile>> | undefined;
  let pending: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  try {
    // Abort stops materialization. Its cleanup ledger and actual IO receipts must
    // survive until the owned native files have drained and been removed.
    ledger = await createDestinationCustody(
      scratch,
      {
        ...source,
        async entryAt(ordinal) {
          basic();
          const entry = await source.entryAt(ordinal);
          basic();
          return entry;
        },
      },
      options.maxCustodyBytes,
      () => {},
    );
    check();
    await admitDestinationCounts(mounts, ledger);
    const custody = ledger;
    const folders = createDestinationDirectories(mounts, parents, custody, check);
    directories = folders;
    folders.createStages();
    const inventory = createDestinationInventory(custody, folders);
    let censused = false;
    function run<T>(work: () => Promise<T>) {
      check();
      if (pending || active) return Promise.reject(new Error("Checkpoint destination work is already running."));
      const task = work();
      pending = task;
      void task
        .finally(() => {
          if (pending === task) pending = undefined;
        })
        .catch(() => {});
      return task;
    }
    async function locate(entry: CheckpointArchiveEntry) {
      const ordinal = await custody.locate(entry);
      check();
      return ordinal;
    }
    async function createEntry(requested: CheckpointArchiveEntry) {
      const ordinal = await locate(requested);
      const entry = await custody.entryAt(ordinal);
      if (custody.read(ordinal)[0]) throw new Error("Checkpoint destination entry already exists.");
      const parent = await folders.openParent(entry);
      try {
        parent.validateNative();
        if (entry.kind === "directory") {
          // The wrapper only admits directories; the native operation is exclusive.
          destinationMkdir(parent.descriptor, parent.name);
        } else if (entry.kind === "symlink") destinationSymlink(parent.descriptor, parent.name, entry.link_target);
        else throw new Error("Checkpoint destination entry is not a directory or link.");
        parent.refresh();
        if (entry.kind === "symlink") destinationLinkTime(parent.descriptor, parent.name, entry.mtime_ns);
        const stat = destinationStat(parent.descriptor, parent.name);
        if (entry.kind === "symlink" && stat.mtimeNs !== BigInt(entry.mtime_ns))
          throw new Error("Checkpoint link timestamp differs.");
        custody.retain(ordinal, stat, 2);
        fsyncSync(parent.descriptor);
        parent.validateNative();
      } finally {
        parent.close();
      }
    }
    function finalize(entry: CheckpointArchiveEntry) {
      return finalizeDestinationDirectory(entry, custody, folders);
    }
    function abort() {
      void close(options.signal?.reason).catch(() => {});
    }
    function close(_reason?: unknown) {
      closing ??= (async () => {
        closed = true;
        options.signal?.removeEventListener("abort", abort);
        await drainDestinationClose(
          () => active,
          () => pending,
          async () => {
            cleaning = true;
            if (!published) await inventory.remove();
          },
          async () => {
            try {
              folders.closeDescriptors();
            } finally {
              await custody.close();
            }
          },
        );
      })();
      return closing;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    return {
      get bytes() {
        return custody.bytes();
      },
      validate: folders.validate,
      createDirectory(entry: CheckpointArchiveEntry) {
        return run(async () => {
          if (entry.kind !== "directory") throw new Error("Expected checkpoint directory.");
          await createEntry(entry);
        });
      },
      createLink(entry: CheckpointArchiveEntry) {
        return run(async () => {
          if (entry.kind !== "symlink") throw new Error("Expected checkpoint link.");
          await createEntry(entry);
        });
      },
      openFile(entry: CheckpointArchiveEntry) {
        return run(async () => {
          active = await openDestinationFile(entry, custody, folders, check, () => {
            active = undefined;
          });
          check();
          return active;
        });
      },
      census() {
        return run(async () => {
          await inventory.census(true);
          check();
          // The last caller callback must precede all final physical facts.
          nativePhase = true;
          try {
            await inventory.census(true);
            folders.validateNative();
            censused = true;
          } finally {
            nativePhase = false;
          }
        });
      },
      finalizeDirectory(entry: CheckpointArchiveEntry) {
        return run(async () => {
          if (!censused) throw new Error("Checkpoint destination census is required.");
          await finalize(entry);
        });
      },
      preparedMounts() {
        return run(async () => {
          if (!censused) throw new Error("Checkpoint destination census is required.");
          await sealDestinationGraph(custody, folders, inventory);
          check();
          nativePhase = true;
          try {
            await sealDestinationGraph(custody, folders, inventory);
          } finally {
            nativePhase = false;
          }
          return folders.stages.map((stage, mount) => {
            const policy = mounts[mount]?.policy;
            if (!policy) throw new Error("Checkpoint destination mount is not admitted.");
            return {
              name: policy.name,
              path: stage.path,
              dev: fstatSync(stage.descriptor, { bigint: true }).dev.toString(),
              ino: fstatSync(stage.descriptor, { bigint: true }).ino.toString(),
            };
          });
        });
      },
      publish() {
        return run(async () => {
          if (!censused) throw new Error("Checkpoint destination census is required.");
          await sealDestinationGraph(custody, folders, inventory);
          check();
          nativePhase = true;
          try {
            await sealDestinationGraph(custody, folders, inventory);
            const roots = await publishDestinationMounts(folders, custody, () =>
              sealDestinationGraph(custody, folders, inventory, true),
            );
            published = true;
            return roots.map((root, mount) => ({ ...root, name: mounts[mount]?.policy.name }));
          } finally {
            nativePhase = false;
          }
        });
      },
      close,
    };
  } catch (error) {
    cleaning = true;
    if (directories) {
      try {
        if (ledger) await createDestinationInventory(ledger, directories).remove();
      } catch {}
      directories.closeDescriptors();
    } else for (const parent of parents.values()) closeSync(parent.descriptor);
    await ledger?.close().catch(() => {});
    throw error;
  }
}
