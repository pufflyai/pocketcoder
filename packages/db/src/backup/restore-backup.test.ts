import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseContext } from "../database/context";
import { PGliteStore } from "../store";
import { createPGliteFixture, insertTestWorkspace } from "../test-fixtures";
import { KEY_NAMES } from "./manifest";
import { restoreBackup } from "./restore-backup";
import { writeBackup } from "./write-backup";

// Each test opens several PGlite engines: source, verifier and restored copy.
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function backedUp() {
  const f = await createPGliteFixture("pc-restore-db", "disk");
  cleanup.push(f.dispose);
  const out = await realpath(await mkdtemp(join(tmpdir(), "pc-restore-out-")));
  cleanup.push(() => rm(out, { recursive: true, force: true }));
  const source = f.context.dataDir as string;
  const journal = f.context.journal?.directory as string;
  const keys = Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
    (typeof KEY_NAMES)[number],
    Buffer
  >;
  const kept = { id: crypto.randomUUID() };
  await f.store.insertMachineKey({
    id: kept.id,
    principalId: f.principal.id,
    secretDigest: new Uint8Array(32),
    scopes: [],
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  const archive = join(out, "controller.tar");
  await writeBackup(f.context, {
    output: archive,
    keys,
    signal: new AbortController().signal,
    freeze: (capture) => capture(() => {}),
  });
  return { f, out, source, journal, archive, kept };
}

test("a restored folder starts in recovery, replays later revocations and then fences its source", async () => {
  const { f, out, source, archive, kept } = await backedUp();
  // This revocation happens after the backup, so only the journal knows about it.
  await f.store.revokeMachineKey(kept.id, new Date());
  await f.store.close();

  const target = join(out, "restored");
  const restored = await restoreBackup({ archive, dataDir: target });
  expect(restored.directory).toBe(join(out, "restored"));
  expect((await readdir(out)).sort()).toEqual(["controller.tar", "restored"]);

  // The restored folder finds the original journal through its database.
  const context = await createDatabaseContext(target);
  const store = new PGliteStore(context);
  expect((await store.recovery.recoveryState())?.recoveryId).toBe(restored.recovery.recoveryId);
  expect((await store.getMachineKeyWithPrincipal(kept.id))?.key.revokedAt).toBeNull();
  for (const event of await store.recovery.recoveryEvents()) await store.recovery.applyRecord(event);
  expect((await store.getMachineKeyWithPrincipal(kept.id))?.key.revokedAt).not.toBeNull();
  await store.recovery.finishRecovery(restored.recovery.recoveryId);
  expect(await store.recovery.recoveryState()).toBeNull();
  await store.close();

  await expect(createDatabaseContext(source)).rejects.toThrow("replaced by a restore");
  const reopened = await createDatabaseContext(target);
  await reopened.close();
});

test("recovery repeats later retirements, narrowing and conversation deletion by exact target", async () => {
  const { f, out } = await backedUp();
  const workspace = await insertTestWorkspace(f, "conversation");
  const now = new Date();
  await f.store.appendConversationMessage({
    workspaceId: workspace.id,
    messageId: crypto.randomUUID(),
    role: "user",
    content: "remove me",
    occurredAt: now,
    metadata: {},
    createdAt: now,
  });
  const reader = await f.store.createPrincipal("reader", ["workspaces:read", "templates:read"], ["*"]);
  const actor = crypto.randomUUID();
  await f.store.insertMachineKey({
    id: actor,
    principalId: f.principal.id,
    secretDigest: new Uint8Array(32),
    scopes: [],
    createdAt: now,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  const archive = join(out, "later.tar");
  await writeBackup(f.context, {
    output: archive,
    keys: Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
      (typeof KEY_NAMES)[number],
      Buffer
    >,
    signal: new AbortController().signal,
    freeze: (capture) => capture(() => {}),
  });
  await f.store.deleteConversation(workspace.id, new Date());
  await f.store.updateManagedPrincipal(actor, reader.id, { scopes: ["templates:read"] });
  await f.store.retireTemplate(actor, f.template.name, f.template.version);
  await f.store.close();

  const restored = await restoreBackup({ archive, dataDir: join(out, "restored") });
  const store = new PGliteStore(await createDatabaseContext(restored.directory));
  try {
    for (const event of await store.recovery.recoveryEvents()) await store.recovery.applyRecord(event);
    expect(await store.readConversation(workspace.id, 0, 10)).toEqual([]);
    expect((await store.getConversationState(workspace.id))?.status).toBe("deleted");
    expect((await store.getPrincipal(reader.id))?.scopes).toEqual(["templates:read"]);
    expect((await store.getTemplate(f.template.name, f.template.version))?.status).toBe("retired");
  } finally {
    await store.close();
  }
}, 30_000);

test("recovery stays closed without the journal that covers the backup", async () => {
  const { f, out, archive } = await backedUp();
  await f.store.close();
  const target = join(out, "restored");
  await restoreBackup({ archive, dataDir: target });
  const elsewhere = join(out, "other-journal");
  await expect(createDatabaseContext(target, { journalDir: elsewhere })).rejects.toThrow("missing");
  expect(existsSync(elsewhere)).toBe(false);
});

test("restore refuses an existing target or a bad archive before writing anything", async () => {
  const { f, out, archive } = await backedUp();
  await f.store.close();
  const taken = join(out, "taken");
  await mkdir(taken);
  await expect(restoreBackup({ archive, dataDir: taken })).rejects.toThrow("already exists");

  const bad = join(out, "bad.tar");
  await writeFile(bad, "not an archive");
  await expect(restoreBackup({ archive: bad, dataDir: join(out, "never") })).rejects.toThrow();
  expect((await readdir(out)).sort()).toEqual(["bad.tar", "controller.tar", "taken"]);
});
