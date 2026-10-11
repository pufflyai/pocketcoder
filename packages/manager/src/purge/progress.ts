import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type AccountPurgeIntent, AccountPurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
import { syncDirectory } from "@pstdio/pocketcoder-db/engine";
import {
  type ObjectStorage,
  ObjectStorageError,
  readPrivateFile,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";

const LIMIT = 65_536;
type Stage = "targets" | "inventory" | "controllers" | "drained" | "stopped" | "deleted";

async function json(response: Response) {
  if (!response.body) throw new Error("Purge progress body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMIT) throw new Error("Purge progress exceeds its metadata limit.");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function createPurgeProgress<T>(
  deps: { directory: string; storage: ObjectStorage; validate: () => void },
  stage: Stage,
  payload: z.ZodType<T>,
  targetId?: string,
) {
  const target = targetId === undefined ? null : z.uuid().parse(targetId);
  const suffix = target ? `${stage}-${target}` : stage;
  const Schema = z.strictObject({
    format: z.literal("pocketcoder-account-purge-progress/v1"),
    intent: AccountPurgeIntentSchema,
    stage: z.literal(stage),
    targetId: z.literal(target),
    recordedAt: z.iso.datetime(),
    payload,
  });
  deps.validate();
  const directory = join(deps.directory, "progress");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  syncDirectory(deps.directory);
  const owned = await lstat(directory);
  async function custody() {
    deps.validate();
    const current = await lstat(directory);
    if (
      !current.isDirectory() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      (current.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Purge progress directory must remain private and direct.");
  }
  await custody();
  const path = (intent: AccountPurgeIntent) => join(directory, `${intent.accountId}-${suffix}.json`);
  const key = (intent: AccountPurgeIntent) => `manager/purge/accounts/${intent.accountId}/${suffix}.json`;
  function bound(input: unknown, intent: AccountPurgeIntent) {
    const record = Schema.parse(input);
    if (!isDeepStrictEqual(record.intent, intent)) throw new Error("Purge progress intent differs.");
    return record;
  }
  async function privateFile(file: string) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > LIMIT)
        throw new Error("Purge progress must be a bounded private file.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function local(intent: AccountPurgeIntent) {
    await custody();
    if (!(await privateFile(path(intent)))) return null;
    const record = bound(JSON.parse((await readPrivateFile(path(intent), LIMIT)).toString()), intent);
    await custody();
    return record;
  }
  async function persist(record: z.infer<typeof Schema>) {
    const prior = await local(record.intent);
    if (prior && !isDeepStrictEqual(prior.payload, record.payload)) throw new Error("Purge progress payload differs.");
    await privateFile(`${path(record.intent)}.tmp`);
    await writePrivateJson(path(record.intent), record, LIMIT);
    await custody();
  }
  async function remote(intent: AccountPurgeIntent) {
    await custody();
    let response: Response;
    try {
      response = await deps.storage.get(key(intent));
    } catch (error) {
      if (error instanceof ObjectStorageError && error.status === 404) return null;
      throw error;
    }
    const version = response.headers.get("x-amz-version-id");
    if (!version || version === "null") {
      await response.body?.cancel();
      throw new Error("Purge progress requires an exact object version.");
    }
    const latest = bound(await json(response), intent);
    const exact = bound(await json(await deps.storage.get(key(intent), version)), intent);
    if (!isDeepStrictEqual(latest, exact)) throw new Error("Purge progress version differs.");
    await custody();
    return exact;
  }
  const pending = new Map<string, Promise<unknown>>();
  async function own<R>(input: AccountPurgeIntent, run: (intent: AccountPurgeIntent) => Promise<R>) {
    const intent = AccountPurgeIntentSchema.parse(input);
    const previous = pending.get(intent.accountId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => run(intent));
    pending.set(intent.accountId, current);
    try {
      return await current;
    } finally {
      if (pending.get(intent.accountId) === current) pending.delete(intent.accountId);
    }
  }
  async function publish(proposed: z.infer<typeof Schema>) {
    const intent = proposed.intent;
    await persist(proposed);
    try {
      const receipt = await deps.storage.putIfAbsent(key(intent), Buffer.from(JSON.stringify(proposed)));
      const published = bound(await json(await deps.storage.get(key(intent), receipt.versionId)), intent);
      if (!isDeepStrictEqual(published, proposed)) throw new Error("Published purge progress differs.");
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
    }
    const acknowledged = await remote(intent);
    if (!acknowledged || !isDeepStrictEqual(acknowledged.payload, proposed.payload))
      throw new Error("Purge progress was not acknowledged.");
    await persist(acknowledged);
    return acknowledged;
  }
  return {
    acknowledge: (intent: AccountPurgeIntent) =>
      own(intent, async (bound) => {
        const candidate = await local(bound);
        const canonical = await remote(bound);
        if (canonical) {
          await persist(canonical);
          return canonical;
        }
        // Retry the exact locally durable effect receipt without repeating its external effect.
        return candidate ? publish(candidate) : null;
      }),
    read: (intent: AccountPurgeIntent) =>
      own(intent, async (bound) => {
        await local(bound);
        const record = await remote(bound);
        if (record) await persist(record);
        return record;
      }),
    retain: (intent: AccountPurgeIntent, input: unknown) =>
      own(intent, async (bound) => {
        const value = payload.parse(input);
        const localRecord = await local(bound);
        const canonical = await remote(bound);
        const prior = canonical ?? localRecord;
        if (prior && !isDeepStrictEqual(prior.payload, value)) throw new Error("Purge progress payload differs.");
        if (canonical) {
          await persist(canonical);
          return canonical;
        }
        const proposed =
          prior ??
          Schema.parse({
            format: "pocketcoder-account-purge-progress/v1",
            intent: bound,
            stage,
            targetId: target,
            recordedAt: new Date().toISOString(),
            payload: value,
          });
        // Ownership survives an uncertain write; timestamps and resource IDs must not change on retry.
        return publish(proposed);
      }),
  };
}
