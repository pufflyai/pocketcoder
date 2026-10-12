import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lockDataFolder, syncDirectory } from "@pstdio/pocketcoder-db/engine";
import {
  ObjectStorage,
  type ObjectStorageConfig,
  ObjectStorageError,
  readAccountPurgeIntent,
  readPrivateFile,
  requireOutsideDataFolder,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { ManagerError } from "../accounts/errors";
import { managerJournal } from "../recovery/journal";
import { createPurgeCompletion } from "./completion";
import { createRequestDigest, intentKeys, type PurgeIntent, PurgeIntentSchema } from "./intent";
import { createProvisionHistory } from "./provision-history";

export interface PurgeAuthorityConfig {
  directory: string;
  storage: ObjectStorageConfig;
}
const equal = (left: PurgeIntent, right: PurgeIntent) => JSON.stringify(left) === JSON.stringify(right);

export async function createPurgeAuthority(dataDir: string, config: PurgeAuthorityConfig) {
  // The configured parent exists outside rollback; publish only this owned child.
  try {
    await mkdir(config.directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const folder = lockDataFolder(config.directory);
  try {
    syncDirectory(dirname(folder.dir));
    await requireOutsideDataFolder(dataDir, folder.dir);
    const directory = join(folder.dir, "intents");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    syncDirectory(folder.dir);
    const directoryInfo = await lstat(directory);
    if (
      !directoryInfo.isDirectory() ||
      (directoryInfo.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error("Purge intents require a private, direct directory.");
    const storage = new ObjectStorage(config.storage);
    const dependencies = { directory: folder.dir, storage, validate: folder.validate };
    const journal = await managerJournal(dependencies);
    const completion = await createPurgeCompletion(dependencies);
    const history = await createProvisionHistory(dependencies);
    const accounts = new Map<string, PurgeIntent>();
    const requests = new Map<string, PurgeIntent>();
    function remember(intent: PurgeIntent) {
      folder.validate();
      for (const prior of [accounts.get(intent.accountId), requests.get(intent.createRequestDigest)])
        if (prior && !equal(prior, intent)) throw new Error("Purge tombstone identity differs.");
      accounts.set(intent.accountId, intent);
      requests.set(intent.createRequestDigest, intent);
    }
    for (const name of await readdir(directory)) {
      if (name.endsWith(".tmp")) continue;
      const intent = PurgeIntentSchema.parse(
        JSON.parse((await readPrivateFile(join(directory, name), 65_536)).toString()),
      );
      if (name !== `${intent.accountId}.json`) throw new Error("Purge intent filename differs.");
      remember(intent);
    }
    async function read(key: string, versionId?: string) {
      return readAccountPurgeIntent(await storage.get(key, versionId));
    }
    async function persist(intent: PurgeIntent) {
      remember(intent);
      await writePrivateJson(join(directory, `${intent.accountId}.json`), intent, 65_536);
      folder.validate();
    }
    async function acknowledge(intent: PurgeIntent) {
      await persist(intent);
      for (const key of intentKeys(intent)) {
        try {
          const receipt = await storage.putIfAbsent(key, Buffer.from(JSON.stringify(intent)));
          if (!equal(await read(key, receipt.versionId), intent)) throw new Error("Purge tombstone version differs.");
        } catch (error) {
          if (!(error instanceof ObjectStorageError) || error.status !== 412) throw error;
          if (!equal(await read(key), intent)) throw new Error("Immutable purge tombstone differs.");
        }
        if (!equal(await read(key), intent)) throw new Error("Purge tombstone was not acknowledged.");
      }
      await journal.append(intent);
    }
    async function importRemoteIntents() {
      for (const item of await storage.versions("manager/purge/accounts/")) {
        if (!/^manager\/purge\/accounts\/[a-f0-9-]+\/intent\.json$/.test(item.key)) continue;
        if (!item.latest) continue;
        if (item.deleted) throw new Error("A permanent purge tombstone was deleted.");
        const intent = await read(item.key, item.versionId);
        if (intentKeys(intent)[0] !== item.key) throw new Error("Remote purge tombstone path differs.");
        await persist(intent);
      }
    }
    let refreshing: Promise<void> | undefined;
    function refresh() {
      refreshing ??= (async () => {
        folder.validate();
        await journal.refresh();
        for (const intent of journal.intents()) await persist(intent);
        await importRemoteIntents();
        // Local intent survives a failed remote write and a database rollback.
        for (const intent of accounts.values()) await acknowledge(intent);
      })().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    }
    await refresh();
    return {
      refresh,
      acknowledge,
      journal,
      completion,
      history,
      storage,
      dependencies,
      intents: () => [...accounts.values()],
      account: (id: string) => accounts.get(id),
      request: (requestId: string) => requests.get(createRequestDigest(requestId)),
      operation: (id: string) => [...accounts.values()].find((intent) => intent.operationId === id),
      assertAccount(id: string) {
        folder.validate();
        if (accounts.has(id)) throw new ManagerError(409, "account_purged");
      },
      assertRequest(requestId: string) {
        folder.validate();
        if (requests.has(createRequestDigest(requestId))) throw new ManagerError(409, "account_purged");
      },
      close: () => folder.close(),
    };
  } catch (error) {
    folder.close();
    throw error;
  }
}
export type PurgeAuthority = Awaited<ReturnType<typeof createPurgeAuthority>>;
