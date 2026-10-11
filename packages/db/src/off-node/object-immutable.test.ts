import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ObjectStorageError } from "./object-storage";
import { objectStorageFixture } from "./object-storage-fixture";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "conditional tombstone creation refuses an actual versioned object overwrite",
  async () => {
    const fixture = await objectStorageFixture();
    try {
      const key = `manager/purge/accounts/${randomUUID()}/intent.json`;
      const bytes = Buffer.from("permanent first intent");
      const create = fixture.storage.putIfAbsent.bind(fixture.storage);
      const first = await create(key, bytes);
      expect(await (await fixture.storage.get(key, first.versionId)).text()).toBe(bytes.toString());
      let failure: unknown;
      try {
        await create(key, Buffer.from("conflicting intent"));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ObjectStorageError);
      expect((failure as ObjectStorageError).status).toBe(412);
      expect(await fixture.storage.versions(key)).toHaveLength(1);
      expect(await (await fixture.storage.get(key)).text()).toBe(bytes.toString());
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
