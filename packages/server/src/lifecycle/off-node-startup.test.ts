import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreBackup } from "@pstdio/pocketcoder-db/backup";
import { createControllerBackup } from "../backup/controller-backup";
import { openControllerStore } from "../bootstrap/controller-store";
import { loadConfig } from "../config/config";
import { createMaintenance } from "../maintenance/maintenance";
import { RecoveryRequiredError, startPocketCoderServer, startRecoveryController } from "./lifecycle";

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

test("an absent data folder initializes privately, while recovery exposes writer identity before remote transfer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-startup-"));
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const endpoint = closed.url.toString();
  closed.stop(true);
  let recovery: Awaited<ReturnType<typeof startRecoveryController>> | undefined;
  try {
    const key = join(root, "outer-key");
    await writeFile(key, randomBytes(32), { mode: 0o600 });
    const configFile = join(root, "off-node.json");
    await writeFile(
      configFile,
      JSON.stringify({
        accountId: randomUUID(),
        encryptionKeyFile: key,
        storage: {
          endpoint,
          bucket: "backup",
          region: "us-east-1",
          accessKeyId: "key",
          secretAccessKey: "secret",
          forcePathStyle: true,
        },
      }),
      { mode: 0o600 },
    );
    const config = {
      ...loadConfig({ POCKETCODER_DIR: join(root, "source"), POCKETCODER_OFF_NODE_CONFIG: configFile }),
      listenPort: 0,
      agentPort: 0,
    };
    await expect(startPocketCoderServer(config, { log: () => {} })).rejects.toMatchObject({ code: "journal.pending" });
    expect(await Bun.file(join(config.dataDir, "keys", "auth-pepper")).exists()).toBe(true);
    expect(await Bun.file(join(config.dataDir, "admin.sock")).exists()).toBe(false);
    const source = await openControllerStore(config.dataDir);
    try {
      await createControllerBackup({ store: source.store, keys: source.keys, maintenance: createMaintenance() })(
        { output: join(root, "backup.tar"), timeout_ms: 5000 },
        new AbortController().signal,
      );
    } finally {
      await source.store.close();
    }
    const restored = await restoreBackup({ archive: join(root, "backup.tar"), dataDir: join(root, "fresh") });
    const freshConfig = { ...config, dataDir: restored.directory };
    await expect(startPocketCoderServer(freshConfig, { log: () => {} })).rejects.toBeInstanceOf(RecoveryRequiredError);
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
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
