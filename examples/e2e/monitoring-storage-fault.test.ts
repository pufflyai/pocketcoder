import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ObjectStorage } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { command } from "./local-process";
import { storageWriteFaultProxy } from "./monitoring-storage-fault";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "storage fault preserves signed reads and writes, and blocks only writes",
  async () => {
    const network = `pc53-storage-test-${randomUUID()}`;
    await command(["docker", "network", "create", network], { quiet: true });
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let proxy: Awaited<ReturnType<typeof storageWriteFaultProxy>> | undefined;
    try {
      fixture = await objectStorageFixture();
      await command(["docker", "network", "connect", network, fixture.config.bucket], { quiet: true });
      const { stdout: address } = await command(
        [
          "docker",
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          fixture.config.bucket,
        ],
        { quiet: true },
      );
      proxy = await storageWriteFaultProxy(`http://${address}:9000`, network);
      const storage = new ObjectStorage({ ...fixture.config, endpoint: proxy.hostEndpoint });
      const receipt = await storage.putIfAbsent("private/signed object", Buffer.from("real stored bytes"));
      expect(await (await storage.get(receipt.key, receipt.versionId)).text()).toBe("real stored bytes");
      await proxy.failWrites(true);
      await expect(storage.put("blocked", Buffer.from("write"))).rejects.toMatchObject({ status: 503 });
      expect(await (await storage.get(receipt.key, receipt.versionId)).text()).toBe("real stored bytes");
      await proxy.failWrites(false);
      await storage.put("recovered", Buffer.from("restored write"));
      expect(await (await storage.get("recovered")).text()).toBe("restored write");
    } finally {
      await proxy?.close();
      await fixture?.close();
      await command(["docker", "network", "rm", network], { quiet: true });
    }
  },
  60_000,
);
