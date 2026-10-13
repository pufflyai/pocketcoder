import { expect, test } from "bun:test";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { initializeStorage } from "./storage-contract";

test.skipIf(process.env.PC103_S3_TEST !== "1")(
  "deployment proves atomic writer publication and removes its real probe",
  async () => {
    const fixture = await objectStorageFixture();
    try {
      const retained = await fixture.storage.put("retained-user-data", Buffer.from("retain this version"));
      await initializeStorage(fixture.storage);
      await initializeStorage(fixture.storage);
      expect(await fixture.storage.versions("deployment-probes/")).toEqual([]);
      expect(await (await fixture.storage.get(retained.key, retained.versionId)).text()).toBe("retain this version");
    } finally {
      await fixture.close();
    }
  },
  30_000,
);
