import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { loadManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import {
  createRequestDigest,
  intentKeys,
  type PurgeIntentSchema,
  purgeRequestDigest,
} from "@pstdio/pocketcoder-manager/purge";
import { loadConfig } from "@pstdio/pocketcoder-server/config";
import { startPocketCoderServer } from "@pstdio/pocketcoder-server/lifecycle";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "manager-owned private CREATE binding fences an alias core under the original permanent intent",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-alias-core-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
    let failure: unknown;
    const failures: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const originalId = randomUUID();
      const aliasId = randomUUID();
      const requestId = randomUUID();
      const master = join(root, "master-key");
      await writeFile(master, randomBytes(32), { mode: 0o600 });
      const managerConfig = join(root, "manager-backup.json");
      await writeFile(managerConfig, JSON.stringify({ storage: fixture.config, encryptionKeyFile: master }), {
        mode: 0o600,
      });
      const backups = await loadManagerBackupConfig(managerConfig, join(root, "manager_data"));
      const projected = backups.accountFiles(aliasId, requestId);
      const keyPath = join(root, "alias-outer-key");
      await writeFile(keyPath, Buffer.from(projected["outer-key"] ?? "", "base64"), { mode: 0o600 });
      const configPath = join(root, "alias-off-node.json");
      const projectedConfig = JSON.parse(Buffer.from(projected["config.json"] ?? "", "base64").toString());
      await writeFile(configPath, JSON.stringify({ ...projectedConfig, encryptionKeyFile: keyPath }), { mode: 0o600 });
      const directory = join(root, "alias-data");
      const config = {
        ...loadConfig({ POCKETCODER_DIR: directory, POCKETCODER_OFF_NODE_CONFIG: configPath }),
        listenPort: 0,
        agentPort: 0,
      };
      running = await startPocketCoderServer(config, { log: () => {} });
      const owner = await fetch("http://localhost/v1/owner", {
        signal: AbortSignal.timeout(2000),
        unix: join(directory, "admin.sock"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: randomUUID(),
          automation: true,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      expect(owner.status).toBe(201);
      const result = (await owner.json()) as { token: string; key: { id: string } };
      const headers = { authorization: `Bearer ${result.token}` };
      expect((await fetch(`${running.url}/v1/workspaces`, { headers, signal: AbortSignal.timeout(2000) })).status).toBe(
        200,
      );
      const intent: ReturnType<typeof PurgeIntentSchema.parse> = {
        format: "pocketcoder-account-purge/v1",
        accountId: originalId,
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(requestId),
        purgeRequestDigest: purgeRequestDigest(randomUUID()),
        admittedAt: new Date().toISOString(),
      };
      for (const key of intentKeys(intent)) {
        const receipt = await fixture.storage.putIfAbsent(key, Buffer.from(JSON.stringify(intent)));
        expect(await (await fixture.storage.get(key, receipt.versionId)).json()).toEqual(intent);
      }
      const response = await fetch(`${running.url}/v1/workspaces`, { headers, signal: AbortSignal.timeout(2000) });
      console.log(
        JSON.stringify({
          aliasCoreFence: { originalId, aliasId, operationId: intent.operationId, status: response.status },
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "account.purged" } });
      const keyStatus = await fetch(`http://localhost/v1/account/purge/keys/${result.key.id}`, {
        signal: AbortSignal.timeout(2000),
        unix: join(directory, "admin.sock"),
      });
      expect(await keyStatus.json()).toMatchObject({
        account_id: aliasId,
        operation_id: intent.operationId,
        key: { id: result.key.id, revoked_at: null },
      });
      const cleanup = await fetch("http://localhost/v1/account/purge", {
        signal: AbortSignal.timeout(5000),
        unix: join(directory, "admin.sock"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation_id: intent.operationId }),
      });
      expect(cleanup.status).toBe(200);
      const cleanupResult = (await cleanup.json()) as { keys_revoked_at?: string };
      expect(cleanupResult).toMatchObject({
        account_id: aliasId,
        operation_id: intent.operationId,
        operation_state: "succeeded",
        keys_revoked_at: expect.any(String),
        compute_proof: { evidence: [] },
      });
      const revoked = await fetch(`http://localhost/v1/account/purge/keys/${result.key.id}`, {
        signal: AbortSignal.timeout(2000),
        unix: join(directory, "admin.sock"),
      });
      expect(await revoked.json()).toMatchObject({
        account_id: aliasId,
        operation_id: intent.operationId,
        key: { id: result.key.id, revoked_at: cleanupResult.keys_revoked_at },
      });
      await running.stop();
      running = undefined;
      const fresh = join(root, "fresh-alias");
      await expect(startPocketCoderServer({ ...config, dataDir: fresh }, { log: () => {} })).rejects.toThrow(
        "Account purge requires private cleanup",
      );
      expect(await Bun.file(join(fresh, "LOCK")).exists()).toBe(false);
    } catch (error) {
      failure = error;
    } finally {
      const results = await Promise.allSettled([running?.stop(), fixture?.close()]);
      results.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      failures.push(...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])));
    }
    if (failures.length)
      throw new AggregateError([...(failure ? [failure] : []), ...failures], "Alias core cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
