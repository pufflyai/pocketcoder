import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStorageError, writePrivateJson } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { ManagerStore } from "../database/store";
import { createRequestDigest, purgeRequestDigest } from "../purge/intent";
import { captureManagerBackup, completeManagerRecovery, restoreManagerBackup } from "./manager-backup";

const enabled = process.env.PC102_S3_TEST === "1";
const plan = { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" };

test.skipIf(!enabled)(
  "restoring an encrypted manager backup replays later purges before admission",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc102-recovery-"));
    const storage = await objectStorageFixture();
    const dataDir = join(root, "manager");
    const target = join(root, "restored");
    const purge = { directory: join(root, "authority"), storage: storage.config };
    const encryptionKeyFile = join(root, "backup-key");
    await writeFile(encryptionKeyFile, randomBytes(32), { mode: 0o600 });
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    try {
      store = await ManagerStore.create(dataDir, purge);
      const expiry = new Date(Date.now() + 3600_000);
      const token = await store.createOperator(expiry);
      const deleted = await store.createAccount("delete-account", { name: "deleted private name" }, () => plan, expiry);
      const survivor = await store.createAccount("keep-account", { name: "survivor" }, () => plan, expiry);
      await store.close();
      store = undefined;
      const options = { dataDir, purge, encryptionKeyFile, operationId: randomUUID() };
      proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = decodeURIComponent(url.pathname.slice(`/${storage.config.bucket}/`.length));
          if (request.method === "PUT" && path.startsWith("manager/writers/"))
            return new Response(null, { status: 503 });
          try {
            return await storage.storage.request(
              request.method,
              path,
              Object.fromEntries(url.searchParams),
              request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
              request.headers.has("if-none-match")
                ? { "if-none-match": request.headers.get("if-none-match") as string }
                : {},
            );
          } catch (error) {
            if (error instanceof ObjectStorageError) return new Response(null, { status: error.status });
            throw error;
          }
        },
      });
      await expect(
        captureManagerBackup({
          ...options,
          purge: { ...purge, storage: { ...storage.config, endpoint: proxy.url.toString() } },
        }),
      ).rejects.toThrow("503");
      await proxy.stop(true);
      proxy = undefined;
      store = await ManagerStore.create(dataDir, purge);
      expect((await store.operator(token))?.expiresAt).toEqual(expiry);
      await store.close();
      store = undefined;
      const receipt = await captureManagerBackup(options);
      const configPath = join(root, "off-node.json");
      const purgePath = join(root, "purge.json");
      const receiptPath = join(root, "receipt.json");
      await writePrivateJson(configPath, { storage: storage.config, encryptionKeyFile });
      await writePrivateJson(purgePath, purge);
      const command = async (directory: string, action: string, operationId: string) => {
        const child = Bun.spawn(
          [process.execPath, "--no-env-file", "packages/manager/src/index.ts", action, receiptPath, operationId],
          {
            env: {
              ...process.env,
              POCKETCODER_MANAGER_DIR: directory,
              POCKETCODER_MANAGER_PURGE_CONFIG: purgePath,
              POCKETCODER_MANAGER_OFF_NODE_CONFIG: configPath,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [code, output, errors] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(errors);
        return JSON.parse(output) as { state?: string; operation_id: string };
      };
      expect((await command(dataDir, "backup", options.operationId)).operation_id).toBe(options.operationId);
      expect(await captureManagerBackup(options)).toEqual(receipt);
      const bytes = new Uint8Array(
        await (await storage.storage.get(receipt.object.key, receipt.object.versionId)).arrayBuffer(),
      );
      expect(Buffer.from(bytes).includes(Buffer.from(token))).toBe(false);
      expect(Buffer.from(bytes).includes(Buffer.from("deleted private name"))).toBe(false);

      const clone = join(root, "clone-without-marker");
      await mkdir(clone, { mode: 0o700 });
      await cp(join(dataDir, "db"), join(clone, "db"), { recursive: true });
      await cp(join(dataDir, "FORMAT"), join(clone, "FORMAT"));
      await expect(ManagerStore.create(clone, purge)).rejects.toThrow("recovery");
      await expect(ManagerStore.create(clone)).rejects.toThrow("journal configuration");
      const incomplete = { ...options, dataDir: join(root, "incomplete"), receipt, operationId: randomUUID() };
      await mkdir(incomplete.dataDir, { mode: 0o700 });
      await writePrivateJson(join(incomplete.dataDir, "RECOVERY.json"), {
        operationId: incomplete.operationId,
        receipt,
        phase: "restoring",
      });
      await expect(completeManagerRecovery(incomplete)).rejects.toThrow("incomplete");
      await writeFile(join(incomplete.dataDir, "FORMAT"), "pocketcoder-manager/v1\n", { mode: 0o600 });
      await expect(completeManagerRecovery(incomplete)).rejects.toThrow("incomplete");
      await expect(ManagerStore.create(incomplete.dataDir, purge)).rejects.toThrow("recovery");
      await restoreManagerBackup(incomplete);
      await expect(ManagerStore.create(incomplete.dataDir, purge)).rejects.toThrow("recovery");
      store = await ManagerStore.create(dataDir, purge);
      await store.purge?.acknowledge({
        format: "pocketcoder-account-purge/v1",
        accountId: deleted.account.id,
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest("delete-account"),
        purgeRequestDigest: purgeRequestDigest("purge-account"),
        admittedAt: new Date().toISOString(),
      });
      await store.close();
      store = undefined;
      const restore = { dataDir: target, purge, encryptionKeyFile, receipt, operationId: randomUUID() };
      expect((await command(target, "restore", restore.operationId)).state).toBe("recovery_required");
      await rm(join(target, "FORMAT"));
      await restoreManagerBackup(restore);
      await expect(ManagerStore.create(target, purge)).rejects.toThrow("recovery");
      const journal = join(purge.directory, "manager-journal");
      await rename(journal, `${journal}.held`);
      await expect(completeManagerRecovery(restore)).rejects.toThrow("journal evidence is missing");
      await expect(ManagerStore.create(target, purge)).rejects.toThrow("recovery");
      await rename(`${journal}.held`, journal);
      store = await ManagerStore.create(dataDir, purge);
      await expect(completeManagerRecovery(restore)).rejects.toThrow();
      await store.close();
      store = undefined;
      expect((await command(target, "recover", restore.operationId)).state).toBe("completed");
      store = await ManagerStore.create(target, purge);
      expect((await store.listAccounts()).map((account) => account.id)).toEqual([survivor.account.id]);
      expect((await store.pendingOperations()).map((operation) => operation.id)).toEqual([survivor.operation.id]);
      expect((await store.operator(token))?.expiresAt).toEqual(expiry);
      await expect(
        store.createAccount("delete-account", { name: "deleted private name" }, () => plan, expiry),
      ).rejects.toThrow("account_purged");
      await store.close();
      store = undefined;
      await expect(ManagerStore.create(dataDir, purge)).rejects.toThrow("retired");
      await expect(
        completeManagerRecovery({ ...restore, receipt: { ...receipt, operationId: randomUUID() } }),
      ).rejects.toThrow("identity differs");
      await captureManagerBackup({ ...options, dataDir: target, operationId: randomUUID() });
      await completeManagerRecovery(restore);
      store = await ManagerStore.create(target, purge);
      expect((await store.pendingOperations()).map((operation) => operation.id)).toEqual([survivor.operation.id]);
    } finally {
      await store?.close();
      await proxy?.stop(true);
      await storage.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
