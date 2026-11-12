import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import migrations from "../../assets/migrations.json" with { type: "json" };
import { createPGliteContext } from "../database/pglite-context";
import { pgliteSqlClient } from "../database/sql-client";
import { getMigrationStatus, migrateDatabase } from "./migrator";

test("migration registry applies in order and does not repeat writes", async () => {
  const client = await PGlite.create({ postgresqlconf: ["shared_buffers = 16MB"], relaxedDurability: false });
  try {
    const names = await migrateDatabase(pgliteSqlClient(client));
    expect(names.length).toBeGreaterThan(0);
    expect(await migrateDatabase(pgliteSqlClient(client))).toEqual([]);
    expect((await getMigrationStatus(pgliteSqlClient(client))).map((row) => row.name)).toEqual(names);
  } finally {
    await client.close();
  }
});

test.each(["drift", "newer", "gap"])("rejects %s history before applying pending migrations", async (kind) => {
  const context = await createPGliteContext();
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
    await expect(migrateDatabase(pgliteSqlClient(client))).rejects.toThrow();
    expect((await client.query("SELECT * FROM pocketcoder.__drizzle_migrations ORDER BY id")).rows).toEqual(before);
  } finally {
    await context.close();
  }
});

test("the managed upgrade clears old profiles and preserves the principal", async () => {
  const db = await PGlite.create();
  try {
    const client = pgliteSqlClient(db);
    await migrateDatabase(client, migrations.slice(0, -1));
    const principal = crypto.randomUUID();
    await client.query(
      "INSERT INTO pocketcoder.principals (id,name,scopes,template_names,created_at) VALUES ($1,'upgrade-test',ARRAY['admin'],ARRAY['*'],now())",
      [principal],
    );
    await client.query(
      "INSERT INTO pocketcoder.managed_profiles (profile_id,revision,principal_id,profile,business_slots) VALUES ($1,1,$2,'{}','[]')",
      [crypto.randomUUID(), principal],
    );
    expect(await migrateDatabase(client)).toEqual([migrations.at(-1)!.name]);
    expect(await client.query("SELECT name FROM pocketcoder.principals WHERE id=$1", [principal])).toEqual([
      { name: "upgrade-test" },
    ]);
    expect(await client.query("SELECT * FROM pocketcoder.managed_profiles")).toEqual([]);
  } finally {
    await db.close();
  }
});
