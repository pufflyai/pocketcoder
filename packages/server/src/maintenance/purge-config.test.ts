import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "../lifecycle/lifecycle";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "backup-disabled accounts require their private purge authority before first start",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-purge-config-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
    try {
      fixture = await objectStorageFixture();
      const accountId = randomUUID();
      const path = join(root, "purge.json");
      await writeFile(path, JSON.stringify({ accountId, storage: fixture.config }), { mode: 0o600 });
      const directory = join(root, "data");
      const config = {
        ...loadConfig({ POCKETCODER_DIR: directory, POCKETCODER_PURGE_CONFIG: path }),
        listenPort: 0,
        agentPort: 0,
      };
      running = await startPocketCoderServer(config, { log: () => {} });
      expect((await fetch(`${running.url}/v1/openapi.json`)).status).toBe(200);
      const key = join(root, "outer-key");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      const offNode = join(root, "off-node.json");
      await writeFile(
        offNode,
        JSON.stringify({ accountId: randomUUID(), storage: fixture.config, encryptionKeyFile: key }),
        { mode: 0o600 },
      );
      const conflicting = join(root, "conflicting");
      await expect(
        startPocketCoderServer({ ...config, dataDir: conflicting, offNodeConfigFile: offNode }),
      ).rejects.toThrow("without a second purge config");
      expect(await Bun.file(join(conflicting, "LOCK")).exists()).toBe(false);
      await running.stop();
      running = undefined;
      await fixture.close();
      fixture = undefined;
      const offline = join(root, "offline");
      await expect(startPocketCoderServer({ ...config, dataDir: offline }, { log: () => {} })).rejects.toThrow();
      expect(await Bun.file(join(offline, "LOCK")).exists()).toBe(false);
    } finally {
      await running?.stop();
      await fixture?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
