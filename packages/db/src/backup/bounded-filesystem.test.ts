import { expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { allocated, materialized, sourceFootprint, stagingDisk } from "../off-node/staging-capacity";
import { PGliteStore } from "../store";
import { openRawDatabase } from "./raw-database";

test("an owned physical PGlite copy rejects engine growth before it exceeds admitted bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc93-engine-capacity-"));
  let client: PGlite | undefined;
  let unbounded: PGlite | undefined;
  try {
    const source = await PGliteStore.create(join(root, "source"));
    await source.close();
    const copy = join(root, "copy");
    await cp(join(root, "source", "db"), copy, { recursive: true });
    const disk = await stagingDisk(copy);
    const baseline = allocated(await sourceFootprint(copy), disk.block);
    const budget = { bytes: baseline.bytes + 2 * 1024 ** 2, files: baseline.files + 64 };
    client = await openRawDatabase(copy, budget);
    unbounded = await openRawDatabase(join(root, "source", "db"));
    expect(client.Module.FS.filesystems.NODEFS).not.toBe(unbounded.Module.FS.filesystems.NODEFS);
    console.log(
      "Real PGlite WAL settings",
      await client.query(
        "SELECT current_setting('wal_segment_size') AS segment, current_setting('max_wal_size') AS maximum",
      ),
    );
    await expect(
      client.query(
        "CREATE TABLE staging_growth AS SELECT i, md5(i::text) AS a, md5((i+1)::text) AS b FROM generate_series(1, 200000) i",
      ),
    ).rejects.toMatchObject({ code: "53100" });
    const actual = await materialized([copy]);
    console.log("Real engine capacity rejection", { budget, actual });
    expect(actual.bytes).toBeLessThanOrEqual(budget.bytes);
    expect(actual.files).toBeLessThanOrEqual(budget.files);
    expect((await unbounded.query("SELECT count(*) AS count FROM generate_series(1, 1000)")).rows).toEqual([
      { count: 1000 },
    ]);
  } finally {
    await client?.close();
    await unbounded?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
