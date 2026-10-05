import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "../store";
import { loadCoreAssets } from "./assets";
import { createDatabaseContext } from "./context";

test("first start migrates a private data folder and restart keeps committed rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-pglite-"));
  let store: PGliteStore | undefined;
  try {
    const started = performance.now();
    await loadCoreAssets();
    const assetsReady = performance.now();
    store = await PGliteStore.create(dir);
    console.log(
      JSON.stringify({
        startup: "first",
        assetsMs: assetsReady - started,
        createStoreMs: performance.now() - assetsReady,
      }),
    );
    const principal = await store.createPrincipal("owner", ["admin"], ["*"]);
    expect((await stat(join(dir, "db"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "LOCK"))).mode & 0o777).toBe(0o600);
    await expect(PGliteStore.create(dir)).rejects.toThrow("data folder is in use");
    await store.close();
    const restartStarted = performance.now();
    store = await PGliteStore.create(dir);
    console.log(JSON.stringify({ startup: "restart", ms: performance.now() - restartStarted }));
    expect(await store.getPrincipal(principal.id)).toEqual(principal);
  } finally {
    await store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-memory startup uses the migrated seed and small shared buffers", async () => {
  const context = await createDatabaseContext();
  try {
    expect((await context.client.query<{ fsync: string }>("SHOW fsync")).rows[0]?.fsync).toBe("on");

    expect(
      (await context.client.query<{ shared_buffers: string }>("SHOW shared_buffers")).rows[0]?.shared_buffers,
    ).toBe("16MB");
    expect(await context.db.select().from(context.tables.principals)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an empty data folder cannot silently select memory storage", async () => {
  await expect(PGliteStore.create("")).rejects.toThrow("data folder must not be empty");
});
