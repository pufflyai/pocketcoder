import { fstatSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { type PersistenceMount, PersistenceMountSchema } from "@pstdio/pocketcoder-contracts";
import { createCheckpointDirectoryQueue } from "./directory-queue";
import { openCheckpointDirectory } from "./directory-reader";
import type { createCheckpointEntrySorter } from "./entry-sort";
import { assertCheckpointCustody, checkpointCustody } from "./source-custody";
import { checkpointSourceEntry } from "./source-entry";

type Directory = ReturnType<typeof openCheckpointDirectory>;
type Sorter = ReturnType<typeof createCheckpointEntrySorter>;
type Queue = ReturnType<typeof createCheckpointDirectoryQueue>;
type Pending = NonNullable<Awaited<ReturnType<Queue["take"]>>>;
type Total = { name: string; logical_bytes: number; file_count: number };

interface ScanOptions {
  directory: string;
  maxQueueBytes: number;
  signal?: AbortSignal;
  check(): void;
}

export function checkpointSourcePolicies(sources: readonly { policy: PersistenceMount }[]) {
  if (sources.length > 16) throw new Error("Checkpoint has too many mounts.");
  const policies = sources.map((source) => PersistenceMountSchema.parse(source.policy));
  if (new Set(policies.map((policy) => policy.name)).size !== policies.length)
    throw new Error("Checkpoint mount names must be unique.");
  return policies;
}

async function scanDirectory(
  pending: Pending,
  root: Directory,
  policy: PersistenceMount,
  total: Total,
  sorter: Sorter,
  queue: Queue,
  options: ScanOptions,
  check: () => void,
) {
  root.validate();
  const parent = pending.path ? openCheckpointDirectory(join(root.path, pending.path), check) : root;
  try {
    assertCheckpointCustody(fstatSync(parent.descriptor, { bigint: true }), pending.custody);
    let name = parent.read();
    while (name !== undefined) {
      const path = pending.path ? `${pending.path}/${name}` : name;
      parent.validate();
      const stat = lstatSync(join(parent.path, name), { bigint: true });
      parent.validate();
      total.file_count++;
      if (total.file_count > policy.maxFiles) throw new Error("Checkpoint mount exceeds maxFiles.");
      if (stat.isFile() && stat.size > BigInt(policy.maxBytes - total.logical_bytes))
        throw new Error("Checkpoint mount exceeds maxBytes.");
      const record = await checkpointSourceEntry(parent, pending.mount, path, stat, {
        signal: options.signal,
        check,
      });
      check();
      parent.validate();
      total.logical_bytes += record.entry.size;
      if (!Number.isSafeInteger(total.logical_bytes) || total.logical_bytes > policy.maxBytes)
        throw new Error("Checkpoint mount exceeds maxBytes.");
      await sorter.append(record.entry, record.custody);
      if (record.entry.kind === "directory")
        await queue.append({ mount: pending.mount, path, custody: record.custody });
      check();
      root.validate();
      parent.validate();
      name = parent.read();
    }
  } finally {
    if (parent !== root) parent.close();
  }
}

export async function scanCheckpointSources(
  roots: readonly Directory[],
  policies: readonly PersistenceMount[],
  sorter: Sorter,
  options: ScanOptions,
  check: () => void,
) {
  const queue = createCheckpointDirectoryQueue(options.directory, {
    maxBytes: options.maxQueueBytes,
    signal: options.signal,
    check: options.check,
  });
  let failed = false;
  try {
    const totals = policies.map((policy) => ({ name: policy.name, logical_bytes: 0, file_count: 0 }));
    for (const [mount, root] of roots.entries()) {
      await queue.append({ mount, path: "", custody: checkpointCustody(fstatSync(root.descriptor, { bigint: true })) });
      check();
      root.validate();
    }
    while (true) {
      const pending = await queue.take();
      check();
      if (!pending) break;
      const root = roots[pending.mount];
      const policy = policies[pending.mount];
      const total = totals[pending.mount];
      if (!root || !policy || !total) throw new Error("Unknown checkpoint mount.");
      await scanDirectory(pending, root, policy, total, sorter, queue, options, check);
    }
    return totals;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const closing = queue.close();
    if (failed) await closing.catch(() => {});
    else await closing;
  }
}
