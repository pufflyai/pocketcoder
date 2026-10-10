import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { KEY_NAMES, restoreBackup, writeBackup } from "@pstdio/pocketcoder-db/backup";
import { checkpointHttpFixture } from "./checkpoint-transfer-fixture.test";

test("restore preserves an external checkpoint archive and reopens the durable controller", async () => {
  const fixture = await checkpointHttpFixture(new TextEncoder().encode("checkpoint bytes"));
  const directory = await mkdtemp(join(tmpdir(), "pc-backup-checkpoint-"));
  try {
    const pending = fixture.service.preserve(fixture.workspace, fixture.checkpoint, fixture.operationId);
    const grant = await fixture.grant;
    expect((await fetch(grant.url, { method: "PUT", headers: fixture.headers(grant), body: fixture.raw })).status).toBe(
      201,
    );
    await pending;
    const archive = join(directory, "controller.tar");
    await writeBackup(fixture.context, {
      output: archive,
      checkpointDirectory: fixture.directory,
      keys: Object.fromEntries(KEY_NAMES.map((name) => [name, randomBytes(32)])) as Record<
        (typeof KEY_NAMES)[number],
        Buffer
      >,
      signal: new AbortController().signal,
      freeze: (capture) => capture(() => {}),
    });
    await fixture.store.close();
    const checkpoints = join(directory, "checkpoints");
    await mkdir(checkpoints);
    const restored = await restoreBackup({ archive, dataDir: join(directory, "restored"), checkpointDir: checkpoints });
    expect(restored.checkpoints).toBe(1);
    const names = await readdir(checkpoints);
    expect(names.length).toBe(1);
    expect(await readFile(join(checkpoints, names[0] as string))).toEqual(Buffer.from(fixture.raw));
    const store = await PGliteStore.create(restored.directory);
    await store.close();
  } finally {
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
