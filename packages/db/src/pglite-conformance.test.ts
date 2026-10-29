import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStoreContract } from "@pstdio/pocketcoder-testkit";
import { createPGliteContext } from "./database/pglite-context";
import { getMigrationStatus, migrateDatabase } from "./migrations/migrator";
import { DatabaseStore } from "./store";

for (const mode of ["memory", "disk"] as const) {
  registerStoreContract(`PGlite (${mode})`, {
    async create() {
      const dir = mode === "disk" ? await mkdtemp(join(tmpdir(), "pc-contract-")) : undefined;
      const store = await DatabaseStore.openPGlite(dir);
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
    const context = await createPGliteContext();
    try {
      expect(await migrateDatabase(context.sql)).toEqual([]);
      expect((await getMigrationStatus(context.sql)).every((row) => row.appliedAt && !row.drifted)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("allows only one coordinator on an in-memory store", async () => {
    const store = await DatabaseStore.openPGlite();
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
