import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialMigration, openMigrationDatabase, upgradeMigration } from "./crash-fixture";
import { migrateDatabase } from "./migrator";

test("SIGKILL during an upgrade rolls back its schema and history, then reapplies it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pc-upgrade-"));
  const database = join(dir, "db");
  const marker = join(database, "upgrade-started");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const previous = await openMigrationDatabase(database);
    try {
      expect(await migrateDatabase(previous, [initialMigration])).toEqual(["initial"]);
    } finally {
      await previous.close();
    }
    child = Bun.spawn([process.execPath, join(import.meta.dir, "crash-fixture.ts"), database], {
      stdout: "ignore",
      stderr: "inherit",
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    const recovered = await openMigrationDatabase(database);
    try {
      expect((await recovered.query("SELECT name FROM pocketcoder.__drizzle_migrations ORDER BY id")).rows).toEqual([
        { name: "initial" },
      ]);
      expect((await recovered.query("SELECT to_regclass('pocketcoder.after_upgrade') AS relation")).rows).toEqual([
        { relation: null },
      ]);
      expect(await migrateDatabase(recovered, [initialMigration, upgradeMigration()])).toEqual(["upgrade"]);
      expect((await recovered.query("SELECT name FROM pocketcoder.__drizzle_migrations ORDER BY id")).rows).toEqual([
        { name: "initial" },
        { name: "upgrade" },
      ]);
      expect((await recovered.query("SELECT to_regclass('pocketcoder.after_upgrade') AS relation")).rows).toEqual([
        { relation: "pocketcoder.after_upgrade" },
      ]);
    } finally {
      await recovered.close();
    }
  } finally {
    child?.kill("SIGKILL");
    await child?.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
