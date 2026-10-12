import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { loadCoreAssets } from "./assets";

// PostgreSQL ControlFileData starts with a u64 system id and two u32 versions.
const DB_STATE_OFFSET = 16;
const DB_SHUTDOWNED = 1;

test("the core seed is cleanly shut down so new databases skip crash recovery", async () => {
  const seed = new Bun.Archive((await loadCoreAssets()).seedArchive());
  const [control, ...others] = (await seed.files("**/global/pg_control")).values();
  expect(others).toEqual([]);
  if (!control) throw new Error("core seed has no control file");
  const bytes = await control.bytes();
  expect(new DataView(bytes.buffer, bytes.byteOffset).getInt32(DB_STATE_OFFSET, true)).toBe(DB_SHUTDOWNED);
});

test("disk and memory loaders receive the same raw PostgreSQL seed archive", async () => {
  const assets = await loadCoreAssets();
  const bytes = assets.seedArchive();
  // PGlite's memory loader consumes a raw ustar archive.
  expect(new TextDecoder().decode(bytes.subarray(257, 262))).toBe("ustar");
  const archive = new Bun.Archive(bytes);
  const versions = await archive.files("/PG_VERSION");
  expect(versions.size).toBe(1);
  expect((await versions.values().next().value?.text())?.trim()).toBe("18");
  expect(
    createHash("sha256")
      .update(new Uint8Array(await assets.memorySeed().arrayBuffer()))
      .digest("hex"),
  ).toBe(createHash("sha256").update(bytes).digest("hex"));
});
