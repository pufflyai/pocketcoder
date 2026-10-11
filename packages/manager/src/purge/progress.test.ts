import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockDataFolder } from "@pstdio/pocketcoder-db/engine";
import { ObjectStorage, ObjectStorageError } from "@pstdio/pocketcoder-db/off-node";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { createRequestDigest, purgeRequestDigest } from "./intent";

test.skipIf(process.env.PC94_S3_TEST !== "1")(
  "external purge inventory survives an uncertain acknowledgement and manager rollback",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-progress-"));
    const locks: ReturnType<typeof lockDataFolder>[] = [];
    const fixture = await objectStorageFixture();
    let rejectWrites = true;
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (rejectWrites && request.method === "PUT") return new Response(null, { status: 503 });
        const url = new URL(request.url);
        const key = decodeURIComponent(url.pathname.slice(`/${fixture.config.bucket}/`.length));
        const condition = request.headers.get("if-none-match");
        try {
          return await fixture.storage.request(
            request.method,
            key,
            Object.fromEntries(url.searchParams),
            request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
            condition ? { "if-none-match": condition } : {},
          );
        } catch (error) {
          if (error instanceof ObjectStorageError) return new Response(null, { status: error.status });
          throw error;
        }
      },
    });
    let failure: unknown;
    try {
      const { createPurgeProgress } = await import("./progress");
      const { PurgeInventory } = await import("./physical-state");
      const intent = {
        format: "pocketcoder-account-purge/v1" as const,
        accountId: randomUUID(),
        operationId: randomUUID(),
        createRequestDigest: createRequestDigest(randomUUID()),
        purgeRequestDigest: purgeRequestDigest(randomUUID()),
        admittedAt: new Date().toISOString(),
      };
      const volumeId = randomUUID();
      const label = intent.accountId.replaceAll("-", "");
      const inventory = PurgeInventory.parse({
        accountId: intent.accountId,
        namespaceUid: randomUUID(),
        volumes: [
          {
            claimUid: randomUUID(),
            persistentVolumeUid: randomUUID(),
            attachmentUids: [randomUUID()],
            storage: { driver: "dobs.csi.digitalocean.com", handle: volumeId },
            provider: { provider: "digitalocean", volumeId, snapshotIds: ["12801"] },
            node: null,
          },
        ],
        endpoints: {
          ingressUid: randomUUID(),
          certificateUid: randomUUID(),
          secretUid: randomUUID(),
          hosts: [`${label}.pocketcoder.datazine.app`, `*.${label}.embed.kaset.dev`],
          records: [
            { zone: "datazine.app", id: 41, type: "A", name: `${label}.pocketcoder` },
            { zone: "datazine.app", id: 42, type: "TXT", name: `a-${label}.pocketcoder` },
          ],
        },
      });
      // This is real receipt persistence; these UUIDs do not prove physical deletion.
      const endpoint = new ObjectStorage({ ...fixture.config, endpoint: proxy.url.toString() });
      async function open(name: string) {
        const folder = lockDataFolder(join(root, name));
        locks.push(folder);
        return {
          folder,
          progress: await createPurgeProgress(
            { directory: folder.dir, storage: endpoint, validate: folder.validate },
            "inventory",
            PurgeInventory,
          ),
        };
      }
      const first = await open("authority");
      await expect(first.progress.retain(intent, inventory)).rejects.toThrow("503");
      const path = join(first.folder.dir, "progress", `${intent.accountId}-inventory.json`);
      const candidate = JSON.parse(await readFile(path, "utf8"));
      expect(candidate.payload).toEqual(inventory);
      expect(await first.progress.read(intent)).toBeNull();
      await expect(first.progress.acknowledge(intent)).rejects.toThrow("503");
      first.folder.close();
      rejectWrites = false;
      const restarted = await open("authority");
      expect(await restarted.progress.acknowledge(intent)).toEqual(candidate);
      expect(await restarted.progress.retain(intent, inventory)).toEqual(candidate);
      restarted.folder.close();
      const fresh = await open("restored-manager-authority");
      expect(await fresh.progress.read(intent)).toEqual(candidate);
      expect(await fresh.progress.retain(intent, inventory)).toEqual(candidate);
      await expect(fresh.progress.retain(intent, { ...inventory, namespaceUid: randomUUID() })).rejects.toThrow(
        "differs",
      );
      await expect(fresh.progress.read({ ...intent, operationId: randomUUID() })).rejects.toThrow("intent differs");
      const key = `manager/purge/accounts/${intent.accountId}/inventory.json`;
      const versions = await fixture.storage.versions(key);
      expect(versions).toHaveLength(1);
      const exact = versions[0];
      if (!exact) throw new Error("Actual inventory object version is missing");
      expect(await (await fixture.storage.get(key, exact.versionId)).json()).toEqual(candidate);
      await fixture.storage.put(`accounts/${intent.accountId}/fixture.enc`, Buffer.from("opaque fixture"));
      await fixture.storage.clean(`accounts/${intent.accountId}/`);
      expect(await fixture.storage.versions(key)).toEqual(versions);
      expect(await fresh.progress.read(intent)).toEqual(candidate);
      await expect(
        fresh.progress.retain(intent, { ...inventory, name: "content must not enter the inventory" }),
      ).rejects.toThrow();
    } catch (error) {
      failure = error;
    }
    const results = await Promise.allSettled([proxy.stop(true), fixture.close()]);
    for (const folder of locks) folder.close();
    results.push(...(await Promise.allSettled([rm(root, { recursive: true, force: true })])));
    const cleanup = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (cleanup.length) throw new AggregateError([failure, ...cleanup], "Progress fixture cleanup failed");
    if (failure) throw failure;
  },
  30_000,
);
