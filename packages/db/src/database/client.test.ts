import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createSchema } from "../schema";
import { createPostgresFixture, insertTestWorkspace, TEST_DATABASE_URL } from "../test-fixtures";

test("runtime tables qualify every table and foreign key with their schema", () => {
  const tables = createSchema("isolated_store");
  const query = drizzle.mock().select().from(tables.workspaces).where(eq(tables.workspaces.externalId, "a'quoted"));
  expect(query.toSQL().sql).toContain('"isolated_store"."workspaces"');
  expect(query.toSQL().params).toEqual(["a'quoted"]);
  for (const table of Object.values(tables)) {
    const config = getTableConfig(table);
    expect(config.schema).toBe("isolated_store");
    for (const key of config.foreignKeys) {
      expect(getTableConfig(key.reference().foreignTable).schema).toBe("isolated_store");
    }
  }
});

describe.skipIf(!TEST_DATABASE_URL)("typed database behavior", () => {
  test("stores isolate concurrent queries and round-trip arrays and binary values", async () => {
    const a = await createPostgresFixture("pc40_a");
    const b = await createPostgresFixture("pc40_b");
    try {
      const scopes = ["comma,value", 'quote"value', "slash\\value", "", "NULL"];
      const [left, right] = await Promise.all([
        a.store.createPrincipal("same-name", scopes, []),
        b.store.createPrincipal("same-name", [], ["other"]),
      ]);
      expect(await a.store.getPrincipalByName("same-name")).toEqual(left);
      expect(await b.store.getPrincipalByName("same-name")).toEqual(right);
      expect(left.scopes).toEqual(scopes);
      const key = {
        id: randomUUID(),
        principalId: left.id,
        secretDigest: new Uint8Array([0, 255, 92, 34]),
        scopes,
        createdAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      };
      await a.store.insertMachineKey(key);
      expect((await a.store.getMachineKeyWithPrincipal(key.id))?.key).toEqual(key);
      expect(await b.store.getMachineKeyWithPrincipal(key.id)).toBeNull();
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  test("a failed event append rolls back a transition and its history", async () => {
    const fixture = await createPostgresFixture("pc40_rollback");
    try {
      const row = await insertTestWorkspace(fixture, "rollback");
      await fixture.sql.unsafe(
        `ALTER TABLE "${fixture.schema}".event_outbox ADD CONSTRAINT reject_provisioning CHECK (event_type <> 'workspace.provisioning')`,
      );
      await expect(
        fixture.store.transition(row.id, { from: ["queued"], to: "provisioning", at: new Date() }),
      ).rejects.toThrow();
      expect((await fixture.store.getWorkspace(row.id))?.state).toBe("queued");
      expect(await fixture.store.listStateHistory(row.id)).toHaveLength(1);
      expect(await fixture.store.claimDueEvents(new Date(), 10)).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });
});
