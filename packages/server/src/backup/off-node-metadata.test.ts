import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffNodeConfig, readPrivateFile, restoreOffNodeBackup } from "@pstdio/pocketcoder-db/off-node";
import { createPGliteFixture, objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createMaintenance } from "../maintenance/maintenance";
import { createControllerBackup } from "./controller-backup";
import { createOffNodeBackup } from "./off-node-backup";

const enabled = process.env.RUN_S3_INTEGRATION === "1";

async function fixture() {
  const remote = await objectStorageFixture();
  const database = await createPGliteFixture("pc93-metadata-db", "disk");
  const root = await mkdtemp(join(tmpdir(), "pc93-metadata-"));
  let padding = false;
  let blockCleanup = false;
  let uploads = 0;
  const proxy = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url);
      const backup = path.pathname.endsWith("/backup.enc");
      if (backup && blockCleanup && request.method === "DELETE")
        return new Response("cleanup unavailable", { status: 503 });
      if (backup && request.method === "POST" && path.searchParams.has("uploads")) uploads++;
      const response = await fetch(`${remote.config.endpoint}${path.pathname}${path.search}`, {
        method: request.method,
        headers: request.headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      });
      // Forward the real upload, then exercise an unexpectedly large completion envelope.
      if (padding && backup && request.method === "POST" && path.searchParams.has("uploadId") && response.ok) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(
          (await response.text()).replace(/<ETag>[^<]*<\/ETag>/, `<ETag>${"e".repeat(5000)}</ETag>`),
          {
            status: response.status,
            headers,
          },
        );
      }
      return response;
    },
  });
  const key = join(root, "outer-key");
  await writeFile(key, randomBytes(32), { mode: 0o600 });
  const config = join(root, "off-node.json");
  await writeFile(
    config,
    JSON.stringify({
      accountId: randomUUID(),
      encryptionKeyFile: key,
      storage: { ...remote.config, endpoint: proxy.url.toString() },
    }),
    { mode: 0o600 },
  );
  const offNode = await loadOffNodeConfig(config);
  const backup = createOffNodeBackup({
    store: database.store,
    offNode,
    backup: createControllerBackup({
      store: database.store,
      maintenance: createMaintenance(),
      keys: {
        pepper: randomBytes(32).toString("base64url"),
        eventSigningKey: randomBytes(32).toString("base64url"),
        secretKey: randomBytes(32).toString("base64url"),
      },
    }),
  });
  return {
    root,
    database,
    remote,
    offNode,
    backup,
    get uploads() {
      return uploads;
    },
    pad() {
      padding = true;
    },
    blockCleanup() {
      blockCleanup = true;
    },
    recover() {
      blockCleanup = false;
      padding = false;
    },
    async close() {
      proxy.stop(true);
      const results = await Promise.allSettled([
        database.dispose(),
        remote.close(),
        rm(root, { recursive: true, force: true }),
      ]);
      for (const result of results)
        if (result.status === "rejected") console.error("Metadata fixture cleanup failed", result.reason);
    },
  };
}

async function inventory(f: Awaited<ReturnType<typeof fixture>>, minimum: number) {
  const identities = [];
  const ids = [];
  // This exercises accepted database/schema inventory, not normal managed account concurrency.
  while (Buffer.byteLength(JSON.stringify({ runtimes: identities })) < minimum) {
    const id = randomUUID();
    const ref = {
      kind: "kubernetes",
      id: `pocketcoder-pool-${id}`,
      namespace: `pc-account-${f.offNode.config.accountId}`,
      jobUid: randomUUID(),
      poolRuntimeId: id,
    };
    identities.push({ kind: "warm", id, provider: "kubernetes", ref });
    ids.push(id);
    await f.database.store.insertWarmPoolRuntime({
      id,
      templateId: f.database.template.id,
      templateName: f.database.template.name,
      templateVersion: f.database.template.version,
      templateDigest: f.database.template.digest,
      driverKind: "kubernetes",
      eligibilityFingerprint: "metadata-bound",
      state: "ready",
      providerRef: ref,
      enrollmentDigest: null,
      enrollmentExpiresAt: null,
      workspaceId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      readyAt: new Date(),
      leasedAt: null,
      failureCode: null,
    });
  }
  expect(Buffer.byteLength(JSON.stringify({ runtimes: identities }))).toBeLessThan(65_536);
  return ids;
}

for (const kind of ["known envelope", "remote completion"] as const) {
  test.skipIf(!enabled)(
    `capture retires only owned staging after ${kind} exceeds readable metadata`,
    async () => {
      const f = await fixture();
      try {
        const ids = await inventory(f, kind === "known envelope" ? 65_000 : 63_000);
        if (kind === "remote completion") f.pad();
        const id = randomUUID();
        const directory = join(f.root, "operations", id);
        const prefix = `accounts/${f.offNode.config.accountId}/backups/${id}/`;
        await expect(f.backup(id, new AbortController().signal)).rejects.toThrow("private file limit");
        expect(f.uploads).toBe(kind === "known envelope" ? 0 : 1);
        expect(await f.remote.storage.versions(prefix)).toEqual([]);
        expect(await f.remote.storage.multipart(prefix)).toEqual([]);
        expect(await readdir(directory)).toEqual([]);
        expect((await f.database.store.storageReservations.usage(null, null)).outstanding).toEqual({
          bytes: 0,
          files: 0,
        });
        for (const runtime of ids)
          await f.database.store.updateWarmPoolRuntime(runtime, { state: "failed" }, new Date());
        const receipt = await f.backup(id, new AbortController().signal);
        expect(JSON.parse((await readPrivateFile(join(directory, "receipt.json"), 65_536)).toString())).toEqual(
          receipt,
        );
        expect(receipt.runtimes).toEqual([]);
      } finally {
        await f.close();
      }
    },
    60_000,
  );
}

test.skipIf(!enabled)(
  "failed remote metadata cleanup retains durable staging ownership until readable completion",
  async () => {
    const f = await fixture();
    try {
      await inventory(f, 63_000);
      f.pad();
      f.blockCleanup();
      const id = randomUUID();
      const directory = join(f.root, "operations", id);
      const prefix = `accounts/${f.offNode.config.accountId}/backups/${id}/`;
      await expect(f.backup(id, new AbortController().signal)).rejects.toThrow("503");
      const versions = await f.remote.storage.versions(prefix);
      expect(versions).toHaveLength(1);
      const version = versions[0];
      if (!version) throw new Error("Actual completed remote version is missing.");
      const intent = JSON.parse((await readPrivateFile(join(directory, "intent.json"), 65_536)).toString());
      expect((await f.database.store.storageReservations.get(intent.reservationId))?.state).toBe("reserved");
      expect(await Bun.file(join(directory, "backup.tar")).exists()).toBe(true);
      expect(await Bun.file(join(directory, "receipt.json")).exists()).toBe(false);
      f.recover();
      const receipt = await f.backup(id, new AbortController().signal);
      expect(receipt.object.versionId).toBe(version.versionId);
      expect(f.uploads).toBe(1);
      expect(await readdir(directory)).toEqual(["receipt.json"]);
      expect(JSON.parse((await readPrivateFile(join(directory, "receipt.json"), 65_536)).toString())).toEqual(receipt);
    } finally {
      await f.close();
    }
  },
  60_000,
);

for (const envelope of ["intent", "capacity"] as const)
  test.skipIf(!enabled)(
    `restore ${envelope} envelope rejects long valid paths before target materialization`,
    async () => {
      const f = await fixture();
      try {
        await inventory(f, envelope === "intent" ? 62_000 : 61_000);
        const receipt = await f.backup(randomUUID(), new AbortController().signal);
        await f.offNode.journal.acknowledge(f.database.store.journalSnapshot());
        const operationId = randomUUID();
        const parent = join(f.root, ...Array.from({ length: 5 }, (_, i) => `${i}-${"p".repeat(145)}`));
        await mkdir(parent, { recursive: true });
        const input = {
          operationId,
          receipt,
          offNode: f.offNode,
          dataDir: join(parent, "fresh"),
          checkpointDir: join(parent, "checkpoints"),
          journalDir: join(parent, "journal"),
        };
        await expect(restoreOffNodeBackup(input)).rejects.toThrow("private file limit");
        expect(await Bun.file(join(input.dataDir, "LOCK")).exists()).toBe(false);
        const directory = join(f.root, "restores", operationId);
        expect(await Bun.file(join(directory, "capacity.json")).exists()).toBe(false);
        const intent = join(directory, "intent.json");
        expect(await Bun.file(intent).exists()).toBe(envelope === "capacity");
        if (envelope === "capacity") await readPrivateFile(intent, 65_536);
      } finally {
        await f.close();
      }
    },
    60_000,
  );
