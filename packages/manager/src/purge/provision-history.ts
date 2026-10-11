import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { syncDirectory } from "@pstdio/pocketcoder-db/engine";
import {
  type ObjectStorage,
  ObjectStorageError,
  readPrivateFile,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";

export const ProvisionIdentitySchema = z.strictObject({
  accountId: z.uuid(),
  createRequestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  originalCreateOperationId: z.uuid(),
});
export const ProvisionAdmissionSchema = z.strictObject({
  format: z.literal("pocketcoder-provision-admission/v1"),
  ...ProvisionIdentitySchema.shape,
  admittedAt: z.iso.datetime(),
});
export const ProvisionStartSchema = z.strictObject({
  format: z.literal("pocketcoder-provision-start/v1"),
  ...ProvisionIdentitySchema.shape,
  startedAt: z.iso.datetime(),
});
export type ProvisionIdentity = z.infer<typeof ProvisionIdentitySchema>;
export type ProvisionAdmission = z.infer<typeof ProvisionAdmissionSchema>;
export type ProvisionStart = z.infer<typeof ProvisionStartSchema>;
type Record = ProvisionAdmission | ProvisionStart;
type Kind = "admission" | "start";
const RecordSchema = z.discriminatedUnion("format", [ProvisionAdmissionSchema, ProvisionStartSchema]);
const LIMIT = 65_536;
const PREFIX = "manager/purge/provision/";
const kind = (record: Record): Kind => (record.format === "pocketcoder-provision-admission/v1" ? "admission" : "start");
const identity = ({ accountId, createRequestDigest, originalCreateOperationId }: ProvisionIdentity) =>
  ProvisionIdentitySchema.parse({ accountId, createRequestDigest, originalCreateOperationId });
const keys = (record: Record) => [
  `${PREFIX}${record.accountId}/${kind(record)}.json`,
  `${PREFIX}requests/${record.createRequestDigest}/${record.accountId}/${kind(record)}.json`,
];
function requireIdentity(left: ProvisionIdentity, right: ProvisionIdentity) {
  if (!isDeepStrictEqual(identity(left), identity(right))) throw new Error("Provision history identity differs.");
}

async function body(response: Response) {
  if (!response.body) throw new Error("Provision history body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMIT) throw new Error("Provision history exceeds its metadata limit.");
      chunks.push(chunk.value);
    }
    return RecordSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

async function privateFile(file: string) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > LIMIT)
      throw new Error("Provision history requires a bounded private file.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonical(records: { localRecords: Record[]; remoteRecords: Record[] }, accountId: string, selected: Kind) {
  const found = (values: Record[]) =>
    values.filter((record) => record.accountId === accountId && kind(record) === selected);
  const remotes = found(records.remoteRecords);
  const locals = found(records.localRecords);
  const first = remotes[0] ?? locals[0];
  if (!first) return null;
  for (const record of [...records.remoteRecords, ...records.localRecords].filter(
    (entry) => entry.accountId === accountId,
  ))
    requireIdentity(record, first);
  for (const record of remotes)
    if (!isDeepStrictEqual(first, record)) throw new Error("Provision history immutable indexes differ.");
  return first;
}

export async function createProvisionHistory(deps: {
  directory: string;
  storage: ObjectStorage;
  validate: () => void;
}) {
  deps.validate();
  if ((await realpath(deps.directory)) !== deps.directory) throw new Error("Provision history root must be canonical.");
  const directory = join(deps.directory, "provision-history");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  deps.validate();
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
      throw new Error("Provision history directory must remain private and direct.");
    deps.validate();
  }
  await custody();
  const path = (accountId: string, selected: Kind) => join(directory, `${accountId}.${selected}.json`);
  async function local(accountId: string, selected: Kind) {
    await custody();
    const file = path(accountId, selected);
    if (!(await privateFile(file))) return null;
    const record = RecordSchema.parse(JSON.parse((await readPrivateFile(file, LIMIT)).toString()));
    if (record.accountId !== accountId || kind(record) !== selected)
      throw new Error("Provision history local identity differs.");
    await custody();
    return record;
  }
  async function persist(record: Record) {
    const prior = await local(record.accountId, kind(record));
    if (prior) requireIdentity(prior, record);
    const file = path(record.accountId, kind(record));
    await privateFile(`${file}.tmp`);
    await custody();
    await writePrivateJson(file, record, LIMIT);
    await custody();
  }
  async function exact(key: string, versionId: string) {
    const response = await deps.storage.get(key, versionId);
    if (response.headers.get("x-amz-version-id") !== versionId) {
      await response.body?.cancel();
      throw new Error("Provision history exact version differs.");
    }
    const record = await body(response);
    if (!keys(record).includes(key)) throw new Error("Provision history index identity differs.");
    await custody();
    return record;
  }
  async function remote(key: string) {
    await custody();
    let response: Response;
    try {
      response = await deps.storage.get(key);
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 404) throw error;
      const versions = (await deps.storage.versions(key)).filter((item) => item.key === key);
      if (versions.length) throw new Error("A permanent provision history index was deleted or unavailable.");
      await custody();
      return null;
    }
    const versionId = response.headers.get("x-amz-version-id");
    if (!versionId || versionId === "null") {
      await response.body?.cancel();
      throw new Error("Provision history requires an exact object version.");
    }
    const latest = await body(response);
    const record = await exact(key, versionId);
    if (!isDeepStrictEqual(latest, record)) throw new Error("Provision history version differs.");
    return record;
  }
  async function localRecords(accountId?: string) {
    await custody();
    const localRecords: Record[] = [];
    for (const name of await readdir(directory)) {
      if (name.endsWith(".tmp")) continue;
      const match = /^([a-f0-9-]+)\.(admission|start)\.json$/.exec(name);
      if (!match) throw new Error("Provision history filename differs.");
      const id = z.uuid().parse(match[1]);
      if (accountId && id !== accountId) continue;
      const record = await local(id, match[2] as Kind);
      if (!record) throw new Error("Provision history local record disappeared.");
      localRecords.push(record);
    }
    return localRecords;
  }
  async function remoteRecords(accountId?: string) {
    const remoteRecords: Record[] = [];
    for (const item of await deps.storage.versions(PREFIX)) {
      if (!item.latest) continue;
      const match =
        /^manager\/purge\/provision\/(?:requests\/[a-f0-9]{64}\/)?([a-f0-9-]+)\/(admission|start)\.json$/.exec(
          item.key,
        );
      if (!match) throw new Error("Provision history remote index path differs.");
      const id = z.uuid().parse(match[1]);
      if (accountId && id !== accountId) continue;
      if (item.deleted) throw new Error("A permanent provision history index was deleted.");
      const record = await remote(item.key);
      if (!record || record.accountId !== id || kind(record) !== match[2])
        throw new Error("Provision history index identity differs.");
      remoteRecords.push(record);
    }
    await custody();
    return remoteRecords;
  }
  async function discover(accountId?: string) {
    const [local, remote] = await Promise.all([localRecords(accountId), remoteRecords(accountId)]);
    return { localRecords: local, remoteRecords: remote };
  }
  async function publishIndex(key: string, record: Record, adopt: boolean) {
    try {
      const receipt = await deps.storage.putIfAbsent(key, Buffer.from(JSON.stringify(record)));
      if (!isDeepStrictEqual(await exact(key, receipt.versionId), record))
        throw new Error("Provision history published index differs.");
      return record;
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
      const existing = await remote(key);
      if (!existing) throw new Error("Provision history conditional index disappeared.");
      requireIdentity(existing, record);
      if (!adopt && !isDeepStrictEqual(existing, record))
        throw new Error("Provision history immutable indexes differ.");
      return existing;
    }
  }
  async function acknowledge(input: Record) {
    let record = input;
    let adopt = true;
    for (const key of keys(record)) {
      record = await publishIndex(key, record, adopt);
      adopt = false;
    }
    for (const key of keys(record))
      if (!isDeepStrictEqual(await remote(key), record))
        throw new Error("Provision history indexes were not acknowledged.");
    await persist(record);
    return record;
  }
  async function publish(bound: ProvisionIdentity, selected: Kind) {
    const prior = await local(bound.accountId, selected);
    if (prior) requireIdentity(prior, bound);
    const candidate =
      prior ??
      RecordSchema.parse(
        selected === "admission"
          ? {
              format: "pocketcoder-provision-admission/v1",
              ...bound,
              admittedAt: new Date().toISOString(),
            }
          : { format: "pocketcoder-provision-start/v1", ...bound, startedAt: new Date().toISOString() },
      );
    // A failed acknowledgement keeps the proposed time without claiming admission or provider absence.
    await persist(candidate);
    const records = await discover(bound.accountId);
    const chosen = canonical(records, bound.accountId, selected);
    if (!chosen) throw new Error("Provision history proposal disappeared.");
    requireIdentity(chosen, bound);
    return acknowledge(chosen);
  }
  async function read(accountId: string) {
    const records = await discover(accountId);
    const admission = canonical(records, accountId, "admission");
    const start = canonical(records, accountId, "start");
    return {
      admission: admission ? ProvisionAdmissionSchema.parse(await acknowledge(admission)) : null,
      start: start ? ProvisionStartSchema.parse(await acknowledge(start)) : null,
    };
  }
  // The held root has one writer; serialize its local publication and discovery too.
  let pending: Promise<unknown> = Promise.resolve();
  async function own<T>(run: () => Promise<T>) {
    const current = pending.catch(() => {}).then(run);
    pending = current;
    return current;
  }
  return {
    admit: (input: ProvisionIdentity) =>
      own(async () => ProvisionAdmissionSchema.parse(await publish(ProvisionIdentitySchema.parse(input), "admission"))),
    start: (input: ProvisionIdentity) =>
      own(async () => ProvisionStartSchema.parse(await publish(ProvisionIdentitySchema.parse(input), "start"))),
    read: (accountId: string) => own(() => read(z.uuid().parse(accountId))),
    listByCreateDigest: (digest: string) =>
      own(async () => {
        const bound = ProvisionIdentitySchema.shape.createRequestDigest.parse(digest);
        const records = await discover();
        const ids = new Set(
          [...records.remoteRecords, ...records.localRecords]
            .filter((record) => record.createRequestDigest === bound)
            .map((record) => record.accountId),
        );
        const result = [];
        for (const id of ids) {
          const history = await read(id);
          const record = history.admission ?? history.start;
          if (!record || record.createRequestDigest !== bound)
            throw new Error("Provision history request identity differs.");
          result.push({ identity: identity(record), ...history });
        }
        return result;
      }),
  };
}
