import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ObjectStorage } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import type { createKubernetesCluster } from "./kubernetes-cluster";

export async function offNodeFixture() {
  let storage = await objectStorageFixture();
  return {
    get storage() {
      return storage;
    },
    close: () => storage.close(),
    async configure(cluster: Awaited<ReturnType<typeof createKubernetesCluster>>) {
      await cluster.run(["docker", "network", "connect", "kind", storage.config.bucket]);
      // Linux Docker can allocate a new random host port when this attachment replaces the gateway.
      const published = await cluster.run(["docker", "port", storage.config.bucket, "9000/tcp"]);
      const hostConfig = { ...storage.config, endpoint: `http://${published}` };
      storage = { ...storage, config: hostConfig, storage: new ObjectStorage(hostConfig) };
      await storage.storage.request("HEAD");
      const address = await cluster.run([
        "docker",
        "inspect",
        "--format",
        '{{(index .NetworkSettings.Networks "kind").IPAddress}}',
        storage.config.bucket,
      ]);
      if (!address) throw new Error("Owned object storage fixture address is missing.");
      const key = join(cluster.directory, "off-node-master-key");
      const config = join(cluster.directory, "off-node-config.json");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      await writeFile(
        config,
        JSON.stringify({ storage: { ...storage.config, endpoint: `http://${address}:9000` }, encryptionKeyFile: key }),
        { mode: 0o600 },
      );
      return loadManagerBackupConfig(config, join(cluster.directory, "manager_data"));
    },
  };
}
