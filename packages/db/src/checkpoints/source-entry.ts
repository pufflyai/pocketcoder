import { createHash } from "node:crypto";
import { type BigIntStats, lstatSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { type CheckpointArchiveEntry, CheckpointArchiveEntrySchema } from "@pstdio/pocketcoder-contracts";
import type { openCheckpointDirectory } from "./directory-reader";
import { assertCheckpointCustody, checkpointCustody } from "./source-custody";
import { openCheckpointSourceFile } from "./source-file";

interface EntryOptions {
  signal?: AbortSignal;
  check(): void;
}

async function fileDigest(
  parent: ReturnType<typeof openCheckpointDirectory>,
  name: string,
  custody: Buffer,
  options: EntryOptions,
) {
  const file = openCheckpointSourceFile(parent, name, custody, options);
  const hash = createHash("sha256");
  try {
    while (true) {
      const bytes = await file.read();
      file.validate();
      if (!bytes) break;
      hash.update(bytes);
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await file.close();
  }
}

export async function checkpointSourceEntry(
  parent: ReturnType<typeof openCheckpointDirectory>,
  mount: number,
  path: string,
  stat: BigIntStats,
  options: EntryOptions,
) {
  if ((stat.mode & 0o6000n) !== 0n) throw new Error("Checkpoint source contains special mode bits.");
  const custody = checkpointCustody(stat);
  const common = { mount, path, mode: Number(stat.mode & 0o777n), mtime_ns: String(stat.mtimeNs) };
  let value: CheckpointArchiveEntry;
  if (stat.isDirectory()) value = { ...common, kind: "directory", size: 0 };
  else if (stat.isFile()) {
    const digest = await fileDigest(parent, basename(path), custody, options);
    value = { ...common, kind: "file", size: Number(stat.size), digest };
  } else if (stat.isSymbolicLink()) {
    parent.validate();
    const bytes = readlinkSync(join(parent.path, basename(path)), { encoding: "buffer" });
    const target = bytes.toString("utf8");
    if (!Buffer.from(target).equals(bytes)) throw new Error("Checkpoint link has invalid UTF-8.");
    value = {
      ...common,
      kind: "symlink",
      mode: 0o777,
      size: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      link_target: target,
    };
  } else throw new Error("Checkpoint source contains an unsupported file type.");
  options.signal?.throwIfAborted();
  options.check();
  options.signal?.throwIfAborted();
  parent.validate();
  assertCheckpointCustody(lstatSync(join(parent.path, basename(path)), { bigint: true }), custody);
  parent.validateNative();
  return { entry: CheckpointArchiveEntrySchema.parse(value), custody };
}
