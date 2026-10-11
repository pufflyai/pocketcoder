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
  "remote journal catches up a revoked retry and fences a replaced writer without restarting it",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc93-remote-journal-"));
    const accountId = randomUUID();
    const outerKey = randomBytes(32);
    const replica = createJournalReplica(fixture.config, accountId, outerKey);
    const directory = join(root, "source");
    let source = await PGliteStore.create(directory, { acknowledgeJournal: replica.acknowledge });
    let fresh: PGliteStore | undefined;
    try {
      await replica.acknowledge(source.journalSnapshot());
      const pepper = "remote-journal-pepper";
      const expires_at = new Date(Date.now() + 60_000).toISOString();
      const caller = await bootstrapLocalOwnerKey(source, pepper, { request_id: "caller", expires_at });
      const target = await bootstrapLocalOwnerKey(source, pepper, { request_id: "target", expires_at });
      const oldWriter = source.journalSnapshot().writer;
      await source.close();
      const endpoint = Bun.serve({ port: 0, fetch: () => new Response() });
      const unavailable = endpoint.url.toString();
      endpoint.stop(true);
      const offline = createJournalReplica({ ...fixture.config, endpoint: unavailable }, accountId, outerKey);
      source = await PGliteStore.create(directory, { acknowledgeJournal: offline.acknowledge });
      await expect(source.revokeMachineKey(target.key.id, new Date(), caller.key.id)).rejects.toMatchObject({
        code: "journal.pending",
      });
      expect((await source.getMachineKeyWithPrincipal(target.key.id))?.key.revokedAt).not.toBeNull();
      expect((await replica.current())?.records.some((record) => record.event.kind === "key_revoked")).toBe(false);
      await source.close();
      source = await PGliteStore.create(directory, { acknowledgeJournal: replica.acknowledge });
      expect(await source.revokeMachineKey(target.key.id, new Date(), caller.key.id)).toBe(false);
      expect((await replica.current())?.head).toEqual(source.journalSnapshot().head);
      fresh = await PGliteStore.create(join(root, "fresh"));
      const restored = { ...source.journalSnapshot(), writer: fresh.journalSnapshot().writer };
      await replica.transfer(restored, oldWriter);
      const versions = await fixture.storage.versions(`accounts/${accountId}/journal/`);
      await replica.transfer(restored, oldWriter);
      expect(await fixture.storage.versions(`accounts/${accountId}/journal/`)).toEqual(versions);
      // The source never restarted after the transfer and still holds its local writer lock.
      await expect(source.acknowledgeJournal()).rejects.toMatchObject({ code: "journal.pending" });
      await expect(source.revokeMachineKey(target.key.id, new Date(), caller.key.id)).rejects.toMatchObject({
        code: "journal.pending",
      });
      expect((await replica.current())?.head).toEqual(restored.head);
      const selected = (await fixture.storage.versions(`accounts/${accountId}/journal/writers/`)).find((item) =>
        item.key.includes("/1-"),
      );
      if (!selected) throw new Error("Transferred writer claim is missing.");
      const object = Buffer.from(await (await fixture.storage.get(selected.key, selected.versionId)).arrayBuffer());
      expect(object.includes(Buffer.from(target.key.id))).toBe(false);
      expect(object.includes(outerKey)).toBe(false);
    } finally {
      await fresh?.close();
      await source.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
