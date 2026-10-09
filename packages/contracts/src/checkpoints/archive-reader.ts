import { createHash } from "node:crypto";
import { canonicalJson } from "../common/canonical";
import {
  CHECKPOINT_DOCUMENT_BYTES,
  CHECKPOINT_ENTRY_BYTES,
  CHECKPOINT_IO_BYTES,
  CHECKPOINT_PAYLOAD_BYTES,
  type CheckpointArchiveEntry,
  CheckpointArchiveEntrySchema,
  type CheckpointArchiveHeader,
  CheckpointArchiveHeaderSchema,
  CheckpointArchiveSummarySchema,
  checkpointDocument,
  checkpointIndex,
} from "./archive-format";
import { parseCheckpointTarHeader } from "./archive-header";
import { checkpointInput } from "./archive-input";
import { checkpointArchiveState } from "./archive-state";

interface ReadOptions {
  maxArchiveBytes: number;
  signal?: AbortSignal;
  onHeader?(header: CheckpointArchiveHeader): Promise<void>;
  onEntry?(entry: CheckpointArchiveEntry): Promise<void>;
  onData?(entry: CheckpointArchiveEntry, bytes: Buffer): Promise<void>;
  onEntryComplete?(entry: CheckpointArchiveEntry): Promise<void>;
}
type Input = ReturnType<typeof checkpointInput>;

async function padding(input: Input, size: number) {
  if ((await input.read((512 - (size % 512)) % 512)).some((byte) => byte !== 0))
    throw new Error("Invalid checkpoint tar padding.");
}

async function document(input: Input, size: number, limit: number) {
  if (size > limit) throw new Error("Checkpoint metadata document exceeds its size limit.");
  const bytes = await input.read(size);
  await padding(input, size);
  return bytes;
}

async function member(input: Input, name: string, size?: number) {
  const parsed = parseCheckpointTarHeader(await input.read(512));
  if (parsed.name !== name || (size !== undefined && parsed.size !== size))
    throw new Error("Unexpected checkpoint tar member or size.");
  return parsed;
}

async function payload(
  input: Input,
  entry: CheckpointArchiveEntry,
  state: ReturnType<typeof checkpointArchiveState>,
  options: ReadOptions,
) {
  if (entry.kind !== "file") return;
  const hash = createHash("sha256");
  let remaining = entry.size;
  let chunk = 0;
  // One length frame binds the file, independent of HTTP and tar chunk boundaries.
  state.beginPayload(entry.size);
  while (remaining) {
    const size = Math.min(remaining, CHECKPOINT_PAYLOAD_BYTES);
    await member(input, `payload/${checkpointIndex(state.entries - 1)}/${checkpointIndex(chunk++)}`, size);
    let body = size;
    while (body) {
      const bytes = await input.read(Math.min(body, CHECKPOINT_IO_BYTES));
      hash.update(bytes);
      state.payload(bytes);
      await options.onData?.(entry, bytes);
      options.signal?.throwIfAborted();
      body -= bytes.length;
    }
    await padding(input, size);
    remaining -= size;
  }
  if (`sha256:${hash.digest("hex")}` !== entry.digest)
    throw new Error("Checkpoint file content digest does not match.");
}

async function parseArchive(input: Input, options: ReadOptions) {
  const first = await member(input, "checkpoint.json");
  const bytes = await document(input, first.size, CHECKPOINT_DOCUMENT_BYTES);
  const header = checkpointDocument(bytes, CheckpointArchiveHeaderSchema, "header");
  await options.onHeader?.(header);
  options.signal?.throwIfAborted();
  const state = checkpointArchiveState(header, bytes);
  while (true) {
    const next = parseCheckpointTarHeader(await input.read(512));
    if (next.name === "summary.json") {
      const summary = checkpointDocument(
        await document(input, next.size, CHECKPOINT_DOCUMENT_BYTES),
        CheckpointArchiveSummarySchema,
        "summary",
      );
      if (canonicalJson(summary) !== canonicalJson(state.summary()))
        throw new Error("Checkpoint summary does not match observed content.");
      if ((await input.read(1024)).some((byte) => byte !== 0)) throw new Error("Invalid checkpoint tar end.");
      await input.end();
      return { header, summary, archiveBytes: input.bytes, archiveDigest: input.digest() };
    }
    if (next.name !== `entries/${checkpointIndex(state.entries)}.json`)
      throw new Error("Unexpected checkpoint entry order.");
    const record = await document(input, next.size, CHECKPOINT_ENTRY_BYTES);
    const entry = checkpointDocument(record, CheckpointArchiveEntrySchema, "entry");
    state.record(entry, record);
    await options.onEntry?.(entry);
    options.signal?.throwIfAborted();
    await payload(input, entry, state, options);
    await options.onEntryComplete?.(entry);
    options.signal?.throwIfAborted();
  }
}

export async function readCheckpointArchive(source: ReadableStream<Uint8Array>, options: ReadOptions) {
  const input = checkpointInput(source, options.maxArchiveBytes, options.signal);
  const archive = await parseArchive(input, options).catch(async (error) => {
    await input.close().catch(() => {});
    throw error;
  });
  await input.close();
  return archive;
}
