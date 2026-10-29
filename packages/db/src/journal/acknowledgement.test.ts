import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournalReplica } from "../off-node/journal-replica";
import { objectStorageFixture } from "../off-node/object-storage-fixture";
import { DatabaseStore } from "../store";

test.skipIf(process.env.RUN_S3_INTEGRATION !== "1")(
  "journal health stays unknown until remote acknowledgement succeeds",
  async () => {
    const fixture = await objectStorageFixture();
    const root = await mkdtemp(join(tmpdir(), "pc53-journal-health-"));
    const key = randomBytes(32);
    const account = randomUUID();
    const online = createJournalReplica(fixture.config, account, key);
    let store = await DatabaseStore.openPGlite(root, { acknowledgeJournal: online.acknowledge });
    try {
      expect(store.journalStatus()).toMatchObject({ configured: true, lastAcknowledgedAt: null });
      expect(store.journalStatus().pendingSince).toBeInstanceOf(Date);
      await store.acknowledgeJournal();
      expect(store.journalStatus().lastAcknowledgedAt).toBeInstanceOf(Date);
      expect(store.journalStatus().pendingSince).toBeNull();
      await store.close();
      const probe = Bun.serve({ port: 0, fetch: () => new Response() });
      const endpoint = probe.url.toString();
      probe.stop(true);
      const offline = createJournalReplica({ ...fixture.config, endpoint }, account, key);
      store = await DatabaseStore.openPGlite(root, { acknowledgeJournal: offline.acknowledge });
      await expect(store.acknowledgeJournal()).rejects.toMatchObject({ code: "journal.pending" });
      expect(store.journalStatus()).toMatchObject({ lastAcknowledgedAt: null });
      expect(store.journalStatus().pendingSince).toBeInstanceOf(Date);
      await store.close();
      store = await DatabaseStore.openPGlite(root, { acknowledgeJournal: online.acknowledge });
      await store.acknowledgeJournal();
      expect(store.journalStatus().pendingSince).toBeNull();
    } finally {
      await store.close();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
      await rm(`${root}-journal`, { recursive: true, force: true });
    }
  },
  60_000,
);
