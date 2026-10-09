import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStoreContract } from "@pstdio/pocketcoder-testkit";
import { createDatabaseContext } from "./database/context";
import { getMigrationStatus, migrateDatabase } from "./migrations/migrator";
import { PGliteStore } from "./store";

for (const mode of ["memory", "disk"] as const) {
  registerStoreContract(`PGlite (${mode})`, {
    async create() {
      const dir = mode === "disk" ? await mkdtemp(join(tmpdir(), "pc-contract-")) : undefined;
      const store = await PGliteStore.create(dir);
      return {
        store,
        async dispose() {
          await store.close();
          if (dir) await rm(dir, { recursive: true, force: true });
        },
      };
    },
  });
}

describe("embedded store lifecycle", () => {
  test("seed startup already includes every migration", async () => {
    const context = await createDatabaseContext();
    try {
      expect(await migrateDatabase(context.client)).toEqual([]);
      expect((await getMigrationStatus(context.client)).every((row) => row.appliedAt && !row.drifted)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("allows only one coordinator on an in-memory store", async () => {
    const store = await PGliteStore.create();
    try {
      const release = await store.acquireCoordinatorLease();
      await expect(store.acquireCoordinatorLease()).rejects.toThrow("already active");
      await release();
      await expect(store.acquireCoordinatorLease()).resolves.toBeFunction();
    } finally {
      await store.close();
    }
  });
});
