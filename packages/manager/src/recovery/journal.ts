import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AccountPurgeIntentSchema } from "@pstdio/pocketcoder-contracts";
import {
  type ObjectStorage,
  ObjectStorageError,
  readPrivateFile,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ManagerCursorSchema = z.strictObject({
  journalId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  digest,
});
export type ManagerCursor = z.infer<typeof ManagerCursorSchema>;
const RecordSchema = z.strictObject({
  sequence: z.number().int().positive(),
  previous: digest,
  intent: AccountPurgeIntentSchema,
  digest,
});
const IdentitySchema = z.strictObject({ journalId: z.uuid() });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const limit = 65_536;
const identityKey = "manager/journal/identity.json";

async function json(response: Response) {
  if (!response.body) throw new Error("Manager journal body is missing.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("Manager journal record is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function remote(storage: ObjectStorage, key: string) {
  try {
    return await json(await storage.get(key));
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.status !== 404) throw error;
    if ((await storage.versions(key)).some((entry) => entry.key === key))
      throw new Error("Permanent manager journal evidence was deleted.");
    return null;
  }
}
async function publish(storage: ObjectStorage, key: string, value: unknown) {
  try {
    await storage.putIfAbsent(key, Buffer.from(JSON.stringify(value)));
  } catch (error) {
    if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
  }
  if (!isDeepStrictEqual(await remote(storage, key), value))
    throw new Error("Manager journal acknowledgement differs.");
}

export async function managerJournal(deps: { directory: string; storage: ObjectStorage; validate: () => void }) {
  const directory = join(deps.directory, "manager-journal");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owned = lstatSync(directory);
  function custody() {
    deps.validate();
    const current = lstatSync(directory);
    if (
      !current.isDirectory() ||
      current.ino !== owned.ino ||
      current.dev !== owned.dev ||
      (current.mode & 0o777) !== 0o700 ||
      realpathSync(directory) !== directory
    )
      throw new Error("Manager journal directory must remain private and direct.");
  }
  custody();
  const identityFile = join(directory, "identity.json");
  const observed = await remote(deps.storage, identityKey);
  let identity: z.infer<typeof IdentitySchema>;
  if (existsSync(identityFile)) {
    identity = IdentitySchema.parse(JSON.parse((await readPrivateFile(identityFile, limit)).toString()));
    if (!isDeepStrictEqual(observed, identity))
      throw new Error("Independent manager journal identity is missing or differs.");
  } else {
    identity = IdentitySchema.parse(observed ?? { journalId: randomUUID() });
    await publish(deps.storage, identityKey, identity);
    await writePrivateJson(identityFile, identity, limit);
  }
  const prefix = `manager/journal/${identity.journalId}/`;
  const records: z.infer<typeof RecordSchema>[] = [];
  const acknowledgedSequences = new Set<number>();
  let cursor: ManagerCursor = {
    ...identity,
    sequence: 0,
    digest: hash({ format: "pocketcoder-manager-journal/v1", ...identity }),
  };
  const recordKey = (sequence: number) => `${prefix}${sequence}.json`;
  const recordFile = (sequence: number) => join(directory, `${sequence}.json`);
  const headFile = join(directory, "head.json");
  function accept(input: unknown) {
    const record = RecordSchema.parse(input);
    const body = { sequence: record.sequence, previous: record.previous, intent: record.intent };
    if (record.sequence !== cursor.sequence + 1 || record.previous !== cursor.digest || hash(body) !== record.digest)
      throw new Error("Independent manager journal chain is incomplete.");
    records.push(record);
    cursor = { ...identity, sequence: record.sequence, digest: record.digest };
    return record;
  }
  async function refreshRecord(sequence: number) {
    const local = existsSync(recordFile(sequence))
      ? RecordSchema.parse(JSON.parse((await readPrivateFile(recordFile(sequence), limit)).toString()))
      : undefined;
    const acknowledged = await remote(deps.storage, recordKey(sequence));
    const candidate = acknowledged ?? local;
    if (!candidate) throw new Error("Independent manager journal evidence is missing.");
    if (local && acknowledged && !isDeepStrictEqual(local, acknowledged))
      throw new Error("Manager journal copies differ.");
    const prior = records[sequence - 1];
    if (prior && !isDeepStrictEqual(prior, candidate)) throw new Error("Manager journal record changed.");
    if (!prior) accept(candidate);
    if (!acknowledged) await publish(deps.storage, recordKey(sequence), candidate);
    if (!local) await writePrivateJson(recordFile(sequence), candidate, limit);
    acknowledgedSequences.add(sequence);
  }
  async function refresh() {
    custody();
    const versions = await deps.storage.versions(prefix);
    const latest = versions.filter((entry) => entry.latest);
    if (latest.some((entry) => entry.deleted)) throw new Error("Permanent manager journal evidence was deleted.");
    const localNames = (await readdir(directory)).filter((name) => /^\d+\.json$/.test(name));
    const sequences = latest.map((entry) => {
      const sequence = Number(entry.key.slice(prefix.length).replace(/\.json$/, ""));
      if (!Number.isSafeInteger(sequence) || sequence < 1 || entry.key !== recordKey(sequence))
        throw new Error("Manager journal record path differs.");
      return sequence;
    });
    const retainedHead = existsSync(headFile)
      ? ManagerCursorSchema.parse(JSON.parse((await readPrivateFile(headFile, limit)).toString()))
      : undefined;
    if (retainedHead && retainedHead.journalId !== identity.journalId)
      throw new Error("Manager journal head identity differs.");
    const maximum = Math.max(
      cursor.sequence,
      retainedHead?.sequence ?? 0,
      ...sequences,
      ...localNames.map((name) => Number.parseInt(name, 10)),
    );
    for (let sequence = 1; sequence <= maximum; sequence++) await refreshRecord(sequence);
    if (
      retainedHead &&
      records[retainedHead.sequence - 1]?.digest !== retainedHead.digest &&
      retainedHead.sequence !== 0
    )
      throw new Error("Manager journal head differs.");
    await writePrivateJson(headFile, cursor, limit);
    custody();
  }
  await refresh();
  let pending: Promise<unknown> = Promise.resolve();
  function own<T>(run: () => Promise<T>) {
    const current = pending.catch(() => {}).then(run);
    pending = current;
    return current;
  }
  return {
    refresh: () => own(refresh),
    head: () => ({ ...cursor }),
    intents: () => records.map((record) => record.intent),
    require(cursor: ManagerCursor) {
      const expected = ManagerCursorSchema.parse(cursor);
      const at = expected.sequence
        ? records[expected.sequence - 1]?.digest
        : hash({ format: "pocketcoder-manager-journal/v1", ...identity });
      if (expected.journalId !== identity.journalId || expected.sequence > records.length || expected.digest !== at)
        throw new Error("Independent manager journal does not cover the backup cursor.");
    },
    append: (input: z.infer<typeof AccountPurgeIntentSchema>) =>
      own(async () => {
        const intent = AccountPurgeIntentSchema.parse(input);
        const known = records.find((record) => record.intent.accountId === intent.accountId);
        if (known && acknowledgedSequences.has(known.sequence)) {
          if (!isDeepStrictEqual(known.intent, intent)) throw new Error("Manager journal purge identity differs.");
          return;
        }
        await refresh();
        const prior = records.find((record) => record.intent.accountId === intent.accountId);
        if (prior) {
          if (!isDeepStrictEqual(prior.intent, intent)) throw new Error("Manager journal purge identity differs.");
          return;
        }
        const body = { sequence: cursor.sequence + 1, previous: cursor.digest, intent };
        const record = { ...body, digest: hash(body) };
        await writePrivateJson(recordFile(record.sequence), record, limit);
        accept(record);
        await writePrivateJson(headFile, cursor, limit);
        await publish(deps.storage, recordKey(record.sequence), record);
        acknowledgedSequences.add(record.sequence);
        custody();
      }),
  };
}
