import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountPurgeCompletion, AccountPurgeIntent } from "@pstdio/pocketcoder-contracts";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";
import { loadConfig } from "../config/config";
import { startPurgingController } from "../lifecycle/purging-controller";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "private cleanup refuses fresh data and published completion before it opens the old database",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-purge-custody-"));
    const fixture = await objectStorageFixture();
    try {
      const accountId = randomUUID();
      const directory = join(root, "data");
      const path = join(root, "purge.json");
      await writeFile(path, JSON.stringify({ accountId, storage: fixture.config }), { mode: 0o600 });
      const config = {
        ...loadConfig({ POCKETCODER_DIR: directory, POCKETCODER_PURGE_CONFIG: path }),
        listenPort: 0,
        agentPort: 0,
      };
      await expect(startPurgingController(config, { log: () => {} })).rejects.toThrow(
        "requires permanent purge authority",
      );
      expect(await Bun.file(join(directory, "LOCK")).exists()).toBe(false);
      const intent: AccountPurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId,
        operationId: randomUUID(),
        createRequestDigest: "e".repeat(64),
        purgeRequestDigest: "f".repeat(64),
        admittedAt: new Date().toISOString(),
      };
      const published = await fixture.storage.putIfAbsent(
        `manager/purge/accounts/${accountId}/intent.json`,
        Buffer.from(JSON.stringify(intent)),
      );
      expect(await (await fixture.storage.get(published.key, published.versionId)).json()).toEqual(intent);
      await expect(startPurgingController(config, { log: () => {} })).rejects.toThrow();
      expect(await Bun.file(join(directory, "LOCK")).exists()).toBe(false);
      const original = await openControllerStore(directory);
      await original.store.close();
      const keys = join(directory, "keys");
      const retainedKeys = join(root, "retained-keys");
      await rename(keys, retainedKeys);
      await expect(startPurgingController(config, { log: () => {} })).rejects.toThrow("has no key bundle");
      expect(await Bun.file(join(keys, "auth-pepper")).exists()).toBe(false);
      await rename(retainedKeys, keys);
      // This is an authority-envelope fixture, not proof that a provider has been purged.
      const receipt: AccountPurgeCompletion = {
        format: "pocketcoder-account-purge-completion/v1",
        intent,
        completedAt: new Date().toISOString(),
      };
      const completion = await fixture.storage.putIfAbsent(
        `manager/purge/accounts/${accountId}/complete.json`,
        Buffer.from(JSON.stringify(receipt)),
      );
      expect(await (await fixture.storage.get(completion.key, completion.versionId)).json()).toEqual(receipt);
      const lock = await Bun.file(join(directory, "LOCK")).bytes();
      let reopened: Awaited<ReturnType<typeof startPurgingController>> | undefined;
      let failure: unknown;
      try {
        reopened = await startPurgingController(config, { log: () => {} });
      } catch (error) {
        failure = error;
      } finally {
        await reopened?.stop();
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Account purge is complete");
      expect(await Bun.file(join(directory, "LOCK")).bytes()).toEqual(lock);
      expect(await fixture.storage.versions(`accounts/${accountId}/`)).toEqual([]);
      expect(await fixture.storage.multipart(`accounts/${accountId}/`)).toEqual([]);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
