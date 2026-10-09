import { createHash } from "node:crypto";
import { canonicalJson } from "../common/canonical";
import type { CheckpointArchiveEntry, CheckpointArchiveHeader } from "./archive-format";

function frame(hash: ReturnType<typeof createHash>, bytes: Buffer) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

export function checkpointArchiveState(header: CheckpointArchiveHeader, document: Buffer) {
  const manifest = createHash("sha256");
  const content = createHash("sha256");
  frame(manifest, document);
  frame(content, document);
  const mounts = header.mounts.map(({ name }) => ({ name, logical_bytes: 0, file_count: 0 }));
  let previous: { mount: number; path: Buffer } | undefined;
  let entries = 0;
  return {
    get entries() {
      return entries;
    },
    record(entry: CheckpointArchiveEntry, bytes: Buffer) {
      const path = Buffer.from(entry.path);
      if (
        previous &&
        (entry.mount < previous.mount || (entry.mount === previous.mount && Buffer.compare(path, previous.path) <= 0))
      )
        throw new Error("Checkpoint entries are duplicate or out of order.");
      const mount = mounts[entry.mount];
      const reserved = header.mounts[entry.mount];
      if (!mount || !reserved) throw new Error("Invalid checkpoint entry mount.");
      const logicalBytes = mount.logical_bytes + entry.size;
      const fileCount = mount.file_count + 1;
      if (
        !Number.isSafeInteger(logicalBytes) ||
        logicalBytes > reserved.logical_bytes ||
        fileCount > reserved.file_count
      )
        throw new Error("Checkpoint entry exceeds its declared totals.");
      mount.logical_bytes = logicalBytes;
      mount.file_count = fileCount;
      previous = { mount: entry.mount, path };
      entries++;
      frame(manifest, bytes);
      frame(content, bytes);
    },
    beginPayload(size: number) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(size));
      content.update(length);
    },
    payload(bytes: Buffer) {
      content.update(bytes);
    },
    summary() {
      if (canonicalJson(mounts) !== canonicalJson(header.mounts))
        throw new Error("Checkpoint declared totals do not match content.");
      return {
        mounts,
        manifest_digest: `sha256:${manifest.digest("hex")}`,
        content_digest: `sha256:${content.digest("hex")}`,
      };
    },
  };
}
