import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createDatabaseContext } from "../database/context";
import { getMigrationStatus, migrateDatabase } from "./migrator";

test("migration registry applies in order and does not repeat writes", async () => {
  const client = await PGlite.create({ postgresqlconf: ["shared_buffers = 16MB"], relaxedDurability: false });
  try {
    const names = await migrateDatabase(client);
    expect(names.length).toBeGreaterThan(0);
    expect(await migrateDatabase(client)).toEqual([]);
    expect((await getMigrationStatus(client)).map((row) => row.name)).toEqual(names);
  } finally {
    await client.close();
  }
});

test.each(["drift", "newer", "gap"])("rejects %s history before applying pending migrations", async (kind) => {
  const context = await createDatabaseContext();
  try {
    const client = context.client;
    if (kind === "drift")
      await client.exec("UPDATE pocketcoder.__drizzle_migrations SET hash = 'changed' WHERE id = 1");
    if (kind === "newer")
      await client.exec(
        "INSERT INTO pocketcoder.__drizzle_migrations (hash, name, created_at) VALUES ('future', '20990101000000_future', 9999999999999)",
      );
    if (kind === "gap") await client.exec("DELETE FROM pocketcoder.__drizzle_migrations WHERE id = 1");
    const before = (await client.query("SELECT * FROM pocketcoder.__drizzle_migrations ORDER BY id")).rows;
    await expect(migrateDatabase(client)).rejects.toThrow();
    expect((await client.query("SELECT * FROM pocketcoder.__drizzle_migrations ORDER BY id")).rows).toEqual(before);
  } finally {
    await context.close();
  }
});
