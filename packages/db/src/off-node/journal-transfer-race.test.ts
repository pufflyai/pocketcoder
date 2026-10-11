import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapLocalOwnerKey } from "@pstdio/pocketcoder-runtime-core";
import { PGliteStore } from "../store";
import { createJournalReplica } from "./journal-replica";
import { objectStorageFixture } from "./object-storage-fixture";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "an actual old-writer PUT delayed across transfer cannot replace the remote writer or acknowledge success",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-inflight-journal-"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let delay = false;
    const proxy = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url);
        if (delay && request.method === "PUT" && path.pathname.includes("/heads/0-")) {
          entered();
          await held;
        }
        return fetch(`${fixture.config.endpoint}${path.pathname}${path.search}`, {
          method: request.method,
          headers: request.headers,
          body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
        });
      },
    });
    const accountId = randomUUID();
    const key = randomBytes(32);
    const oldReplica = createJournalReplica({ ...fixture.config, endpoint: proxy.url.toString() }, accountId, key);
    const managerReplica = createJournalReplica(fixture.config, accountId, key);
    let source: PGliteStore | undefined;
    let fresh: PGliteStore | undefined;
    let revocation: Promise<boolean> | undefined;
    try {
      source = await PGliteStore.create(join(root, "source"), { acknowledgeJournal: oldReplica.acknowledge });
      await oldReplica.acknowledge(source.journalSnapshot());
      const pepper = "pc93-inflight-pepper";
      const expires_at = new Date(Date.now() + 60_000).toISOString();
      const caller = await bootstrapLocalOwnerKey(source, pepper, { request_id: "caller", expires_at });
      const target = await bootstrapLocalOwnerKey(source, pepper, { request_id: "target", expires_at });
      const oldWriter = source.journalSnapshot().writer;
      fresh = await PGliteStore.create(join(root, "fresh"));
      delay = true;
      revocation = source.revokeMachineKey(target.key.id, new Date(), caller.key.id);
      await observed;
      const covered = await managerReplica.current();
      if (!covered) throw new Error("Original remote journal is missing.");
      const transferred = { ...covered, writer: fresh.journalSnapshot().writer };
      await managerReplica.transfer(transferred, oldWriter);
      release();
      await expect(revocation).rejects.toMatchObject({ code: "journal.pending" });
      expect((await managerReplica.current())?.writer).toEqual(transferred.writer);
      expect((await managerReplica.current())?.head).toEqual(transferred.head);
      expect((await source.getMachineKeyWithPrincipal(target.key.id))?.key.revokedAt).not.toBeNull();
      expect((await fixture.storage.versions(`accounts/${accountId}/journal/heads/0-`)).length).toBeGreaterThan(1);
      await expect(source.acknowledgeJournal()).rejects.toMatchObject({ code: "journal.pending" });
    } finally {
      release?.();
      await revocation?.catch(() => {});
      await proxy.stop(true);
      await fresh?.close();
      await source?.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
