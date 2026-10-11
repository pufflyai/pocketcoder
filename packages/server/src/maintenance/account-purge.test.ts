import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountPurgeIntent } from "@pstdio/pocketcoder-contracts";
import { loadOffNodeConfig } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { openControllerStore } from "../bootstrap/controller-store";
import { loadConfig } from "../config/config";
import { startPocketCoderServer } from "../lifecycle/lifecycle";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "a permanent remote purge intent fences a live controller before it can expose account data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-live-controller-"));
    let fixture: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let running: Awaited<ReturnType<typeof startPocketCoderServer>> | undefined;
    let failure: unknown;
    const errors: unknown[] = [];
    try {
      fixture = await objectStorageFixture();
      const accountId = randomUUID();
      const directory = join(root, "controller");
      const key = join(root, "outer-key");
      await writeFile(key, randomBytes(32), { mode: 0o600 });
      const path = join(root, "off-node.json");
      await writeFile(path, JSON.stringify({ accountId, storage: fixture.config, encryptionKeyFile: key }), {
        mode: 0o600,
      });
      const offNode = await loadOffNodeConfig(path);
      const controller = await openControllerStore(directory);
      try {
        await offNode.journal.acknowledge(controller.store.journalSnapshot());
      } finally {
        await controller.store.close();
      }
      const config = {
        ...loadConfig({ POCKETCODER_DIR: directory, POCKETCODER_OFF_NODE_CONFIG: path }),
        listenPort: 0,
        agentPort: 0,
      };
      running = await startPocketCoderServer(config, { log: () => {} });
      const owner = await fetch("http://localhost/v1/owner", {
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
      const { token, key: ownerKey } = (await owner.json()) as {
        token: string;
        key: { id: string; expires_at: string };
      };
      const keyStatus = await fetch(`http://localhost/v1/account/purge/keys/${ownerKey.id}`, {
        unix: join(directory, "admin.sock"),
      });
      expect(keyStatus.status).toBe(200);
      expect(await keyStatus.json()).toEqual({
        account_id: accountId,
        operation_id: null,
        key: { id: ownerKey.id, expires_at: ownerKey.expires_at, revoked_at: null },
      });
      const headers = { authorization: `Bearer ${token}` };
      expect((await fetch(`${running.url}/v1/workspaces`, { headers })).status).toBe(200);
      const intent: AccountPurgeIntent = {
        format: "pocketcoder-account-purge/v1",
        accountId,
        operationId: randomUUID(),
        createRequestDigest: "a".repeat(64),
        purgeRequestDigest: "b".repeat(64),
        admittedAt: new Date().toISOString(),
      };
      const receipt = await fixture.storage.put(
        `manager/purge/accounts/${accountId}/intent.json`,
        Buffer.from(JSON.stringify(intent)),
      );
      expect(await (await fixture.storage.get(receipt.key, receipt.versionId)).json()).toEqual(intent);
      const listed = await fetch(`${running.url}/v1/workspaces`, { headers });
      expect(listed.status).toBe(409);
      expect(await listed.json()).toMatchObject({ error: { code: "account.purged" } });
      const mutation = await fetch(`${running.url}/v1/workspaces`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      });
      expect(mutation.status).toBe(409);
      const privateOwner = await fetch("http://localhost/v1/owner", {
        unix: join(directory, "admin.sock"),
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: randomUUID(),
          automation: true,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      expect(privateOwner.status).toBe(409);
      await running.stop();
      running = undefined;
      await expect(startPocketCoderServer(config, { log: () => {} })).rejects.toThrow(
        "Account purge requires private cleanup",
      );
      expect(await Bun.file(join(directory, "admin.sock")).exists()).toBe(false);
      await fixture.storage.clean(`accounts/${accountId}/`);
      const fresh = join(root, "fresh-controller");
      await expect(startPocketCoderServer({ ...config, dataDir: fresh }, { log: () => {} })).rejects.toThrow(
        "Account purge requires private cleanup",
      );
      expect(await fixture.storage.versions(`accounts/${accountId}/`)).toEqual([]);
      expect(await fixture.storage.multipart(`accounts/${accountId}/`)).toEqual([]);
      expect(await Bun.file(join(fresh, "LOCK")).exists()).toBe(false);
      expect(await Bun.file(join(fresh, "keys", "auth-pepper")).exists()).toBe(false);
    } catch (error) {
      failure = error;
    } finally {
      const cleanup = await Promise.allSettled([running?.stop(), fixture?.close()]);
      cleanup.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
      for (const result of cleanup) if (result.status === "rejected") errors.push(result.reason);
    }
    if (errors.length)
      throw new AggregateError([...(failure ? [failure] : []), ...errors], "Live purge fixture cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
