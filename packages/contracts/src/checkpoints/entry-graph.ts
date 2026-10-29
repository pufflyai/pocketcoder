import { posix } from "node:path";
import { type CheckpointArchiveEntry, safeCheckpointLink } from "./archive-format";

type EntryLookup = (mount: number, path: string) => Promise<CheckpointArchiveEntry | null>;

async function validateParents(entry: CheckpointArchiveEntry, lookup: EntryLookup) {
  const parts = entry.path.split("/");
  parts.pop();
  let parent = "";
  for (const part of parts) {
    parent = parent ? `${parent}/${part}` : part;
    const record = await lookup(entry.mount, parent);
    if (record?.kind !== "directory") throw new Error("Checkpoint entry parent is missing or is not a directory.");
  }
}

function checkLink(entry: Extract<CheckpointArchiveEntry, { kind: "symlink" }>) {
  if (!safeCheckpointLink(entry.path, entry.link_target)) throw new Error("Checkpoint link escapes its mount.");
}

async function validateLinkChain(entry: Extract<CheckpointArchiveEntry, { kind: "symlink" }>, lookup: EntryLookup) {
  checkLink(entry);
  const parent = posix.dirname(entry.path);
  const resolved = parent === "." ? [] : parent.split("/");
  let pending = entry.link_target.split("/");
  let links = 0;
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!resolved.length) throw new Error("Checkpoint link chain escapes its mount.");
      resolved.pop();
      continue;
    }
    const path = [...resolved, part].join("/");
    const record = await lookup(entry.mount, path);
    if (record?.kind === "symlink") {
      if (++links > 64) throw new Error("Checkpoint link cycle or chain exceeds 64 hops.");
      checkLink(record);
      // Resolve links before later '..' components, matching actual filesystem lookup.
      pending = [...record.link_target.split("/"), ...pending];
    } else resolved.push(part);
  }
}

export async function validateCheckpointEntryGraph(entry: CheckpointArchiveEntry, lookup: EntryLookup) {
  await validateParents(entry, lookup);
  if (entry.kind === "symlink") await validateLinkChain(entry, lookup);
}
