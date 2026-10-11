import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type AccountPurgeCompletion,
  AccountPurgeCompletionSchema,
  type AccountPurgeIntent,
  AccountPurgeIntentSchema,
} from "@pstdio/pocketcoder-contracts";
import { syncDirectory } from "@pstdio/pocketcoder-db/engine";
import {
  type ObjectStorage,
  ObjectStorageError,
  readPrivateFile,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";

const LIMIT = 65_536;
const key = (accountId: string) => `manager/purge/accounts/${accountId}/complete.json`;

async function readResponse(response: Response) {
  if (!response.body) throw new Error("Purge completion body is missing.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > LIMIT) throw new Error("Purge completion exceeds its metadata limit.");
      chunks.push(chunk.value);
    }
    return AccountPurgeCompletionSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function sameIntent(completion: AccountPurgeCompletion, intent: AccountPurgeIntent) {
  if (!isDeepStrictEqual(completion.intent, intent)) throw new Error("Purge completion intent differs.");
  return completion;
}

export async function createPurgeCompletion(deps: { directory: string; storage: ObjectStorage; validate: () => void }) {
  deps.validate();
  if ((await realpath(deps.directory)) !== deps.directory) throw new Error("Purge authority root must be canonical.");
  const directory = join(deps.directory, "completions");
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
      throw new Error("Purge completion directory must remain private and direct.");
    deps.validate();
  }
  await custody();
  const path = (intent: AccountPurgeIntent) => join(directory, `${intent.accountId}.json`);
  async function privateFile(file: string) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > LIMIT)
        throw new Error("Purge completion must be a bounded private file.");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function local(intent: AccountPurgeIntent) {
    await custody();
    if (!(await privateFile(path(intent)))) return null;
    const completion = AccountPurgeCompletionSchema.parse(
      JSON.parse((await readPrivateFile(path(intent), LIMIT)).toString()),
    );
    await custody();
    return sameIntent(completion, intent);
  }
  async function persist(completion: AccountPurgeCompletion) {
    await local(completion.intent);
    await privateFile(`${path(completion.intent)}.tmp`);
    await custody();
    await writePrivateJson(path(completion.intent), completion, LIMIT);
    await custody();
  }
  async function exact(intent: AccountPurgeIntent, versionId: string) {
    const completion = sameIntent(await readResponse(await deps.storage.get(key(intent.accountId), versionId)), intent);
    await custody();
    return completion;
  }
  async function remote(intent: AccountPurgeIntent) {
    await custody();
    let response: Response;
    try {
      response = await deps.storage.get(key(intent.accountId));
    } catch (error) {
      if (error instanceof ObjectStorageError && error.status === 404) {
        await custody();
        return null;
      }
      throw error;
    }
    const versionId = response.headers.get("x-amz-version-id");
    if (!versionId || versionId === "null") {
      await response.body?.cancel();
      throw new Error("Purge completion requires an exact object version.");
    }
    const latest = sameIntent(await readResponse(response), intent);
    const completion = await exact(intent, versionId);
    if (!isDeepStrictEqual(latest, completion)) throw new Error("Purge completion version differs.");
    return completion;
  }
  async function complete(intent: AccountPurgeIntent) {
    const candidate = await local(intent);
    const canonical = await remote(intent);
    if (canonical) {
      await persist(canonical);
      return canonical;
    }
    const proposed =
      candidate ??
      AccountPurgeCompletionSchema.parse({
        format: "pocketcoder-account-purge-completion/v1",
        intent,
        completedAt: new Date().toISOString(),
      });
    // Keep the proposed timestamp across an uncertain remote acknowledgement.
    await persist(proposed);
    let published: AccountPurgeCompletion;
    try {
      const receipt = await deps.storage.putIfAbsent(key(intent.accountId), Buffer.from(JSON.stringify(proposed)));
      published = await exact(intent, receipt.versionId);
      if (!isDeepStrictEqual(published, proposed)) throw new Error("Published purge completion differs.");
    } catch (error) {
      if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
      const existing = await remote(intent);
      if (!existing) throw new Error("Conditional purge completion disappeared.");
      published = existing;
    }
    if (!isDeepStrictEqual(await remote(intent), published)) throw new Error("Purge completion was not acknowledged.");
    await persist(published);
    return published;
  }
  const pending = new Map<string, Promise<unknown>>();
  async function own<T>(input: AccountPurgeIntent, run: (intent: AccountPurgeIntent) => Promise<T>) {
    const intent = AccountPurgeIntentSchema.parse(input);
    const prior = pending.get(intent.accountId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(() => run(intent));
    pending.set(intent.accountId, current);
    try {
      return await current;
    } finally {
      if (pending.get(intent.accountId) === current) pending.delete(intent.accountId);
    }
  }
  return {
    complete: (intent: AccountPurgeIntent) => own(intent, complete),
    read: (intent: AccountPurgeIntent) =>
      own(intent, async (bound) => {
        await local(bound);
        const completion = await remote(bound);
        if (completion) await persist(completion);
        return completion;
      }),
  };
}
