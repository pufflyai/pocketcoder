import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { registerStoreContract } from "@pstdio/pocketcoder-testkit";
import { SQL } from "bun";
import { getMigrationStatus, migrateDatabase } from "./migrations/migrator";
import { PostgresStore } from "./store";
import { TEST_DATABASE_URL } from "./test-fixtures";

registerStoreContract("PostgreSQL", {
  enabled: Boolean(TEST_DATABASE_URL),
  async create() {
    const url = TEST_DATABASE_URL as string;
    const schema = `pkt_contract_${randomUUID().slice(0, 8)}`;
    const sql = new SQL(url);
    await migrateDatabase(sql, schema);
    const store = new PostgresStore(url, schema);
    await store.init();
    return {
      store,
      async dispose() {
        await store.close();
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await sql.end();
      },
    };
  },
});

describe.skipIf(!TEST_DATABASE_URL)("postgres store lifecycle", () => {
  test("store startup checks migrations without applying them", async () => {
    const url = TEST_DATABASE_URL as string;
    const schema = `pkt_init_${randomUUID().slice(0, 8)}`;
    const sql = new SQL(url);
    const store = new PostgresStore(url, schema);
    try {
      await expect(store.init()).rejects.toThrow("pending migrations");
      expect(
        (await getMigrationStatus(sql, schema)).every((migration) => migration.appliedAt === null),
      ).toBe(true);
      await migrateDatabase(sql, schema);
      await store.init();
    } finally {
      await store.close();
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });

  test("allows only one PostgreSQL coordinator per schema", async () => {
    const url = TEST_DATABASE_URL as string;
    const schema = `pkt_lease_${randomUUID().slice(0, 8)}`;
    const sql = new SQL(url);
    const first = new PostgresStore(url, schema);
    const second = new PostgresStore(url, schema);
    try {
      await migrateDatabase(sql, schema);
      await Promise.all([first.init(), second.init()]);
      const release = await first.acquireCoordinatorLease();
      await expect(second.acquireCoordinatorLease()).rejects.toThrow("already active");
      await release();
      await expect(second.acquireCoordinatorLease()).resolves.toBeFunction();
    } finally {
      await Promise.all([first.close(), second.close()]);
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    }
  });
});
