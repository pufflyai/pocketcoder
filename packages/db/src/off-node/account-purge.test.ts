import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { createAccountPurgeReader } from "./account-purge";
import { objectStorageFixture } from "./object-storage-fixture";

const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
const intent = () => ({
  format: "pocketcoder-account-purge/v1" as const,
  accountId: randomUUID(),
  operationId: randomUUID(),
  createRequestDigest: digest(),
  purgeRequestDigest: digest(),
  admittedAt: new Date().toISOString(),
});

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "private CREATE binding refuses mismatched and conflicting real indexes without changing alias identity",
  async () => {
    const fixture = await objectStorageFixture();
    try {
      const original = intent();
      const aliasId = randomUUID();
      const read = createAccountPurgeReader({
        accountId: aliasId,
        createRequestDigest: original.createRequestDigest,
        storage: fixture.config,
      });
      await fixture.storage.putIfAbsent(
        `manager/purge/requests/${original.createRequestDigest}/intent.json`,
        Buffer.from(JSON.stringify(original)),
      );
      expect(await read()).toEqual(original);
      expect(read.accountId).toBe(aliasId);
      const completion = {
        format: "pocketcoder-account-purge-completion/v1" as const,
        intent: original,
        completedAt: new Date().toISOString(),
      };
      await fixture.storage.putIfAbsent(
        `manager/purge/accounts/${original.accountId}/complete.json`,
        Buffer.from(JSON.stringify(completion)),
      );
      expect(await read.completed()).toEqual(completion);

      const wrongHash = digest();
      await fixture.storage.putIfAbsent(
        `manager/purge/requests/${wrongHash}/intent.json`,
        Buffer.from(JSON.stringify(original)),
      );
      const mismatched = createAccountPurgeReader({
        accountId: randomUUID(),
        createRequestDigest: wrongHash,
        storage: fixture.config,
      });
      await expect(mismatched()).rejects.toThrow("CREATE binding differs");

      const conflictingAlias = randomUUID();
      const conflicting = { ...original, accountId: conflictingAlias, operationId: randomUUID() };
      await fixture.storage.putIfAbsent(
        `manager/purge/accounts/${conflictingAlias}/intent.json`,
        Buffer.from(JSON.stringify(conflicting)),
      );
      const conflict = createAccountPurgeReader({
        accountId: conflictingAlias,
        createRequestDigest: original.createRequestDigest,
        storage: fixture.config,
      });
      await expect(conflict()).rejects.toThrow("indexes differ");
      const direct = createAccountPurgeReader({ accountId: conflictingAlias, storage: fixture.config });
      expect(await direct()).toEqual(conflicting);
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
