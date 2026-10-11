import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_NAMES } from "../backup/manifest";
import { restoreBackup } from "../backup/restore-backup";
import { PGliteStore } from "../store";

test("fresh-volume recovery cannot clear its private state before the new writer is remotely acknowledged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-finish-"));
  const endpoint = Bun.serve({ port: 0, fetch: () => new Response() });
  const unavailable = endpoint.url;
  endpoint.stop(true);
  let source: PGliteStore | undefined;
  let restored: PGliteStore | undefined;
  try {
    source = await PGliteStore.create(join(root, "source"));
    const archive = join(root, "backup.tar");
    await source.backup({
      output: archive,
      keys: Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
        (typeof KEY_NAMES)[number],
        Buffer
      >,
      signal: new AbortController().signal,
      freeze: (capture) => capture(() => {}),
    });
    await source.close();
    const receipt = await restoreBackup({ archive, dataDir: join(root, "fresh") });
    restored = await PGliteStore.create(receipt.directory, {
      acknowledgeJournal: async () => {
        await fetch(unavailable);
      },
    });
    await expect(restored.recovery.finishRecovery(receipt.recovery.recoveryId)).rejects.toMatchObject({
      code: "journal.pending",
    });
    expect((await restored.recovery.recoveryState())?.recoveryId).toBe(receipt.recovery.recoveryId);
    await restored.close();
    // A later healthy retry can finish the same recovery, after its journal has kept the claim.
    const acknowledged = join(root, "acknowledged.json");
    restored = await PGliteStore.create(receipt.directory, {
      acknowledgeJournal: async (snapshot) => {
        await Bun.write(acknowledged, JSON.stringify(snapshot));
      },
    });
    await restored.recovery.finishRecovery(receipt.recovery.recoveryId);
    expect(await restored.recovery.recoveryState()).toBeNull();
    expect((await Bun.file(acknowledged).json()).writer).toEqual(restored.journalSnapshot().writer);
  } finally {
    await restored?.close();
    await source?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
