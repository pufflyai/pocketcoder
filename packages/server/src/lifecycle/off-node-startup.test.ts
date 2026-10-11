import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreBackup } from "@pstdio/pocketcoder-db/backup";
import type { ObjectStorageConfig } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createControllerBackup } from "../backup/controller-backup";
import { loadConfig } from "../config/config";
import { createMaintenance } from "../maintenance/maintenance";
import { RecoveryRequiredError, startPocketCoderServer, startRecoveryController } from "./lifecycle";
import { initializeController } from "./lifecycle-resources";

function status(directory: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ socketPath: join(directory, "admin.sock"), path: "/v1/recovery" }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode as number, body: JSON.parse(body) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function privateConfig(root: string, storage: ObjectStorageConfig) {
  const key = join(root, "outer-key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  const configFile = join(root, "off-node.json");
  await writeFile(configFile, JSON.stringify({ accountId: randomUUID(), encryptionKeyFile: key, storage }), {
    mode: 0o600,
  });
  return {
    ...loadConfig({ POCKETCODER_DIR: join(root, "source"), POCKETCODER_OFF_NODE_CONFIG: configFile }),
    listenPort: 0,
    agentPort: 0,
  };
}

test("required authority outage leaves fresh keys and listeners absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc94-startup-outage-"));
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const endpoint = closed.url.toString();
  closed.stop(true);
  try {
    const config = await privateConfig(root, {
      endpoint,
      bucket: "backup",
      region: "us-east-1",
      accessKeyId: "key",
      secretAccessKey: "secret",
      forcePathStyle: true,
    });
    await expect(startPocketCoderServer(config, { log: () => {} })).rejects.toBeInstanceOf(TypeError);
    expect(await Bun.file(join(config.dataDir, "keys", "auth-pepper")).exists()).toBe(false);
    expect(await Bun.file(join(config.dataDir, "admin.sock")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.env.PC93_S3_TEST !== "1")(
  "an absent data folder initializes privately, while recovery exposes writer identity before remote transfer",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc93-startup-"));
    let storage: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let recovery: Awaited<ReturnType<typeof startRecoveryController>> | undefined;
    try {
      storage = await objectStorageFixture();
      const config = await privateConfig(root, storage.config);
      const source = await initializeController(config, () => {});
      try {
        expect(await Bun.file(join(config.dataDir, "keys", "auth-pepper")).exists()).toBe(true);
        expect(await Bun.file(join(config.dataDir, "admin.sock")).exists()).toBe(false);
        if (!source.keyBundle) throw new Error("Fresh controller key bundle is required");
        await createControllerBackup({ store: source.store, keys: source.keyBundle, maintenance: createMaintenance() })(
          { output: join(root, "backup.tar"), timeout_ms: 5000 },
          new AbortController().signal,
        );
      } finally {
        await source.store.close();
      }
      const restored = await restoreBackup({ archive: join(root, "backup.tar"), dataDir: join(root, "fresh") });
      const freshConfig = { ...config, dataDir: restored.directory };
      await expect(startPocketCoderServer(freshConfig, { log: () => {} })).rejects.toBeInstanceOf(
        RecoveryRequiredError,
      );
      recovery = await startRecoveryController(freshConfig, { log: () => {} });
      const result = await status(restored.directory);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        mode: "recovery",
        complete: false,
        snapshot_id: restored.recovery.snapshotId,
        writer: { directory: restored.directory },
      });
    } finally {
      await recovery?.stop();
      await storage?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
