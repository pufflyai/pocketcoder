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
  checkpointIndex,
} from "./archive-format";
import { checkpointTarHeader } from "./archive-header";
import { checkpointInput } from "./archive-input";
import { checkpointArchiveState } from "./archive-state";

export interface CheckpointArchiveRecord {
  entry: CheckpointArchiveEntry;
  payload?: ReadableStream<Uint8Array>;
}
interface WriteOptions {
  maxArchiveBytes: number;
  signal?: AbortSignal;
}

function document(value: unknown, limit: number) {
  const bytes = Buffer.from(canonicalJson(value));
  if (bytes.length > limit) throw new Error("Checkpoint metadata document exceeds its size limit.");
  return bytes;
}

function* member(name: string, bytes: Buffer) {
  yield checkpointTarHeader(name, bytes.length);
  yield bytes;
  yield Buffer.alloc((512 - (bytes.length % 512)) % 512);
}

async function* payload(
  record: CheckpointArchiveRecord,
  state: ReturnType<typeof checkpointArchiveState>,
  options: WriteOptions,
) {
  const { entry } = record;
  if (entry.kind !== "file") {
    if (record.payload) throw new Error("Only checkpoint files may have a payload.");
    return;
  }
  if (!record.payload) throw new Error("Missing checkpoint file payload.");
  const input = checkpointInput(record.payload, entry.size, options.signal);
  const hash = createHash("sha256");
  let remaining = entry.size;
  let chunk = 0;
  state.beginPayload(entry.size);
  try {
    while (remaining) {
      const size = Math.min(remaining, CHECKPOINT_PAYLOAD_BYTES);
      yield checkpointTarHeader(`payload/${checkpointIndex(state.entries - 1)}/${checkpointIndex(chunk++)}`, size);
      let body = size;
      while (body) {
        const bytes = await input.read(Math.min(body, CHECKPOINT_IO_BYTES));
        state.payload(bytes);
        hash.update(bytes);
        yield bytes;
        body -= bytes.length;
      }
      yield Buffer.alloc((512 - (size % 512)) % 512);
      remaining -= size;
    }
    await input.end();
    if (`sha256:${hash.digest("hex")}` !== entry.digest)
      throw new Error("Checkpoint file content digest does not match.");
  } finally {
    await input.close();
  }
}

async function* archive(
  header: CheckpointArchiveHeader,
  records: AsyncIterable<CheckpointArchiveRecord>,
  options: WriteOptions,
) {
  const validated = CheckpointArchiveHeaderSchema.parse(header);
  const bytes = document(validated, CHECKPOINT_DOCUMENT_BYTES);
  const state = checkpointArchiveState(validated, bytes);
  yield* member("checkpoint.json", bytes);
  for await (const record of records) {
    try {
      options.signal?.throwIfAborted();
      const entry = CheckpointArchiveEntrySchema.parse(record.entry);
      const bytes = document(entry, CHECKPOINT_ENTRY_BYTES);
      state.record(entry, bytes);
      yield* member(`entries/${checkpointIndex(state.entries - 1)}.json`, bytes);
      yield* payload({ ...record, entry }, state, options);
    } finally {
      // Taking a record also takes its payload, even if cancellation precedes its first read.
      await record.payload?.cancel();
    }
  }
  yield* member("summary.json", document(state.summary(), CHECKPOINT_DOCUMENT_BYTES));
  yield Buffer.alloc(1024);
}

export function writeCheckpointArchive(
  header: CheckpointArchiveHeader,
  records: AsyncIterable<CheckpointArchiveRecord>,
  options: WriteOptions,
) {
  if (!Number.isSafeInteger(options.maxArchiveBytes) || options.maxArchiveBytes < 0)
    throw new Error("Invalid checkpoint archive reservation.");
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const iterator = archive(header, records, { ...options, signal });
  let bytes = 0;
  let canceled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const next = await iterator.next();
        signal.throwIfAborted();
        if (next.done) {
          controller.close();
          return;
        }
        bytes += next.value.length;
        if (!Number.isSafeInteger(bytes) || bytes > options.maxArchiveBytes)
          throw new Error("Checkpoint archive exceeds its physical reservation.");
        controller.enqueue(next.value);
      } catch (error) {
        await iterator.return(undefined);
        if (!canceled) controller.error(error);
      }
    },
    async cancel(reason) {
      canceled = true;
      abort.abort(reason instanceof Error ? reason : new Error(String(reason ?? "checkpoint transfer canceled")));
      await iterator.return(undefined);
    },
  });
}
