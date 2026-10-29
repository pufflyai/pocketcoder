import { describe, expect, test } from "bun:test";
import { registerStoreContract } from "@pstdio/pocketcoder-testkit";
import { createPostgresContext } from "./database/postgres-context";
import { postgresSqlClient } from "./database/sql-client";
import { getMigrationStatus } from "./migrations/migrator";
import { createPostgresTestDatabase, TEST_DATABASE_URL } from "./postgres-test-schema";
import { DatabaseStore } from "./store";

registerStoreContract("PostgreSQL", {
  enabled: Boolean(TEST_DATABASE_URL),
  async create() {
    const database = await createPostgresTestDatabase("pc_contract");
    const store = await DatabaseStore.openPostgres(database);
    return {
      store,
      async dispose() {
        await store.close();
        await database.drop();
      },
    };
  },
});

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL store lifecycle", () => {
  test("startup refuses pending migrations instead of applying them", async () => {
    const database = await createPostgresTestDatabase("pc_pending", { migrate: false });
    try {
      await expect(createPostgresContext(database)).rejects.toThrow("run pcd db migrate");
      const status = await getMigrationStatus(postgresSqlClient(database.admin), database.schema);
      expect(status.every((row) => row.appliedAt === null)).toBe(true);
    } finally {
      await database.drop();
    }
  });

  test("allows one coordinator per schema across connections", async () => {
    const database = await createPostgresTestDatabase("pc_lease");
    const first = await DatabaseStore.openPostgres({ url: database.url, schema: database.schema });
    const second = await DatabaseStore.openPostgres({ url: database.url, schema: database.schema });
    try {
      const release = await first.acquireCoordinatorLease();
      await expect(second.acquireCoordinatorLease()).rejects.toThrow("already active");
      await release();
      await expect(second.acquireCoordinatorLease()).resolves.toBeFunction();
    } finally {
      await Promise.all([first.close(), second.close()]);
      await database.drop();
    }
  });
});
