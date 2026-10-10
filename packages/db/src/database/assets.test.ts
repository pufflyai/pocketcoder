import { expect, test } from "bun:test";
import { loadCoreAssets } from "./assets";

// PostgreSQL ControlFileData starts with a u64 system id and two u32 versions.
const DB_STATE_OFFSET = 16;
const DB_SHUTDOWNED = 1;

test("the core seed is cleanly shut down so new databases skip crash recovery", async () => {
  const seed = new Bun.Archive(await (await loadCoreAssets()).loadDataDir.arrayBuffer());
  const [control, ...others] = (await seed.files("**/global/pg_control")).values();
  expect(others).toEqual([]);
  if (!control) throw new Error("core seed has no control file");
  const bytes = await control.bytes();
  expect(new DataView(bytes.buffer, bytes.byteOffset).getInt32(DB_STATE_OFFSET, true)).toBe(DB_SHUTDOWNED);
});
