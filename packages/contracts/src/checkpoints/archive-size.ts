import { canonicalJson } from "../common/canonical";
import {
  CHECKPOINT_DOCUMENT_BYTES,
  CHECKPOINT_ENTRY_BYTES,
  CHECKPOINT_PAYLOAD_BYTES,
  type CheckpointArchiveEntry,
  CheckpointArchiveEntrySchema,
  type CheckpointArchiveHeader,
  CheckpointArchiveHeaderSchema,
} from "./archive-format";
import { checkpointArchiveState } from "./archive-state";

export function checkpointMemberBytes(size: number) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid checkpoint member size.");
  const bytes = 512 + Math.ceil(size / 512) * 512;
  if (!Number.isSafeInteger(bytes)) throw new Error("Checkpoint member size exceeds safe integers.");
  return bytes;
}

function document(value: unknown, limit: number) {
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > limit) throw new Error("Checkpoint metadata document exceeds its size limit.");
  return bytes;
}

export async function measureCheckpointArchive(
  header: CheckpointArchiveHeader,
  entries: AsyncIterable<CheckpointArchiveEntry>,
) {
  const validated = CheckpointArchiveHeaderSchema.parse(header);
  const headerBytes = document(validated, CHECKPOINT_DOCUMENT_BYTES);
  const state = checkpointArchiveState(validated, headerBytes);
  let total = checkpointMemberBytes(headerBytes.length) + 1024;
  function add(bytes: number) {
    total += bytes;
    if (!Number.isSafeInteger(total)) throw new Error("Checkpoint archive size exceeds safe integers.");
  }
  for await (const input of entries) {
    const entry = CheckpointArchiveEntrySchema.parse(input);
    const bytes = document(entry, CHECKPOINT_ENTRY_BYTES);
    state.record(entry, bytes);
    add(checkpointMemberBytes(bytes.length));
    if (entry.kind === "file" && entry.size) {
      const full = Math.floor(entry.size / CHECKPOINT_PAYLOAD_BYTES);
      add(full * checkpointMemberBytes(CHECKPOINT_PAYLOAD_BYTES));
      const remainder = entry.size % CHECKPOINT_PAYLOAD_BYTES;
      if (remainder) add(checkpointMemberBytes(remainder));
    }
  }
  // Both digests have fixed wire lengths; measuring needs no second payload read.
  add(checkpointMemberBytes(document(state.summary(), CHECKPOINT_DOCUMENT_BYTES).length));
  return total;
}
