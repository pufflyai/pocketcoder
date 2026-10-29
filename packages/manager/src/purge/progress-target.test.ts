import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { z } from "zod";
import { createRequestDigest, purgeRequestDigest } from "./intent";
import { createPurgeProgress } from "./progress";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "different target UUID receipts keep the same original intent across restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-target-progress-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let lock: ReturnType<typeof lockDataFolder> | undefined;
    try {
      fixture = await objectStorageFixture();
      const directory = join(root, "authority");
      lock = lockDataFolder(directory);
      const owned = lock;
      const deps = { directory: owned.dir, storage: fixture.storage, validate: () => owned.validate() };
      const intent = {
        format: "pocketcoder-account-purge/v1" as const,
        accountId: randomUUID(),
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(randomUUID()),
        purgeRequestDigest: purgeRequestDigest(randomUUID()),
        admittedAt: new Date().toISOString(),
      };
      const Schema = z.strictObject({ targetAccountId: z.uuid(), namespaceUid: z.uuid(), podUids: z.array(z.uuid()) });
      // These are receipt-storage fixtures, not physical controller exit evidence.
      const first = { targetAccountId: intent.accountId, namespaceUid: randomUUID(), podUids: [randomUUID()] };
      const second = { targetAccountId: randomUUID(), namespaceUid: randomUUID(), podUids: [randomUUID()] };
      const original = await createPurgeProgress(deps, "stopped", Schema, first.targetAccountId);
      const alias = await createPurgeProgress(deps, "stopped", Schema, second.targetAccountId);
      const saved = await original.retain(intent, first);
      const aliasSaved = await alias.retain(intent, second);
      expect(saved.payload).toEqual(first);
      expect(aliasSaved.payload).toEqual(second);
      expect(aliasSaved.intent).toEqual(intent);
      lock.close();
      lock = lockDataFolder(directory);
      const reopened = lock;
      const after = await createPurgeProgress(
        { ...deps, validate: () => reopened.validate() },
        "stopped",
        Schema,
        second.targetAccountId,
      );
      expect(await after.read(intent)).toEqual(aliasSaved);
      await expect(after.read({ ...intent, operationId: randomUUID() })).rejects.toThrow("intent differs");
      expect(
        (await fixture.storage.versions(`manager/purge/accounts/${intent.accountId}/`)).filter(
          (version) => !version.deleted,
        ),
      ).toHaveLength(2);
    } finally {
      lock?.close();
      await fixture?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
