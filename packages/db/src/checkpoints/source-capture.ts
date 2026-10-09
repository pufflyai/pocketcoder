import { lstatSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  type CheckpointArchiveEntry,
  canonicalJson,
  type PersistenceMount,
  validateCheckpointEntryGraph,
} from "@pstdio/pocketcoder-contracts";
import { openCheckpointDirectory } from "./directory-reader";
import { createCheckpointEntrySorter } from "./entry-sort";
import { assertCheckpointCustody } from "./source-custody";
import { openCheckpointSourceFile } from "./source-file";
import { checkpointSourceParent } from "./source-parent";
import { createCheckpointSourcePayload } from "./source-payload";
import { checkpointSourcePolicies, scanCheckpointSources } from "./source-scan";

interface CaptureOptions {
  directory: string;
  maxIndexBytes: number;
  maxQueueBytes: number;
  signal?: AbortSignal;
  check(): void;
}

export async function createCheckpointCapture(
  sources: readonly { root: string; policy: PersistenceMount }[],
  options: CaptureOptions,
) {
  const policies = checkpointSourcePolicies(sources);
  const roots: ReturnType<typeof openCheckpointDirectory>[] = [];
  let sorter: ReturnType<typeof createCheckpointEntrySorter> | undefined;
  let active: ReturnType<typeof createCheckpointSourcePayload> | undefined;
  let opening: Promise<ReturnType<typeof createCheckpointSourcePayload>["stream"]> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  function check() {
    if (closed) throw new Error("Checkpoint capture is closed.");
    options.signal?.throwIfAborted();
    options.check();
    if (closed) throw new Error("Checkpoint capture is closed.");
    options.signal?.throwIfAborted();
  }
  function close() {
    closing ??= (async () => {
      closed = true;
      options.signal?.removeEventListener("abort", abort);
      if (opening) await Promise.allSettled([opening]);
      const jobs = [active?.close(new Error("Checkpoint capture is closed.")), sorter?.close()];
      const results = await Promise.allSettled(jobs);
      const directoryResults = await Promise.allSettled(roots.map(async (root) => root.close()));
      for (const result of [...results, ...directoryResults]) if (result.status === "rejected") throw result.reason;
    })();
    return closing;
  }
  function abort() {
    void close().catch(() => {});
  }
  try {
    for (const source of sources) roots.push(openCheckpointDirectory(source.root, check));
    const scratch = resolve(options.directory);
    if (
      roots.some((root) => {
        const path = relative(root.path, scratch);
        return path !== ".." && !path.startsWith("../");
      })
    )
      throw new Error("Checkpoint scratch must be outside captured mounts.");
    sorter = createCheckpointEntrySorter(options.directory, {
      maxBytes: options.maxIndexBytes,
      signal: options.signal,
      check: options.check,
    });
    const totals = await scanCheckpointSources(roots, policies, sorter, options, check);
    const complete = await sorter.seal();
    for await (const entry of complete.entries()) await validateCheckpointEntryGraph(entry, complete.lookup);
    check();
    for (const root of roots) root.validate();
    async function captured(entry: CheckpointArchiveEntry) {
      check();
      const record = await complete.lookupRecord(entry.mount, entry.path);
      check();
      const root = roots[entry.mount];
      if (!root || !record?.custody || canonicalJson(record.entry) !== canonicalJson(entry))
        throw new Error("Checkpoint entry is not captured.");
      const parent = await checkpointSourceParent(root, entry.mount, entry.path, complete, check);
      return { root, parent, custody: record.custody };
    }
    async function validateEntry(entry: CheckpointArchiveEntry) {
      const source = await captured(entry);
      try {
        check();
        source.parent.validate();
        assertCheckpointCustody(
          lstatSync(join(source.parent.path, basename(entry.path)), { bigint: true }),
          source.custody,
        );
        source.parent.validateNative();
      } finally {
        if (source.parent !== source.root) source.parent.close();
      }
    }
    function openPayload(entry: CheckpointArchiveEntry) {
      if (active || opening) return Promise.reject(new Error("Checkpoint payload is already open."));
      const task = Promise.resolve().then(async () => {
        if (entry.kind !== "file") throw new Error("Checkpoint entry has no file payload.");
        const source = await captured(entry);
        try {
          check();
          const file = openCheckpointSourceFile(source.parent, basename(entry.path), source.custody, {
            signal: options.signal,
            check,
          });
          const payload = createCheckpointSourcePayload(file, {
            signal: options.signal,
            check,
            onClose() {
              try {
                if (source.parent !== source.root) source.parent.close();
              } finally {
                if (active === payload) active = undefined;
              }
            },
          });
          active = payload;
          return payload.stream;
        } catch (error) {
          if (source.parent !== source.root) source.parent.close();
          throw error;
        }
      });
      opening = task;
      const settled = () => {
        if (opening === task) opening = undefined;
      };
      void task.then(settled, settled);
      return task;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      await close();
      options.signal.throwIfAborted();
    }
    return { mounts: totals, entries: complete.entries, lookup: complete.lookup, validateEntry, openPayload, close };
  } catch (error) {
    try {
      await close();
    } catch {
      /* Keep the capture error after draining every owned handle. */
    }
    throw error;
  }
}
