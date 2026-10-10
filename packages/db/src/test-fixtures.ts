import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceInsertResult } from "@pstdio/pocketcoder-runtime-core";
import { getTableName } from "drizzle-orm";
import { createDatabaseContext, notifyChange } from "./database/context";
import { getMigrationStatus, migrateDatabase } from "./migrations/migrator";
import { PGliteStore } from "./store";

export function workspaceOf(result: WorkspaceInsertResult) {
  if (result.kind === "capacity_exceeded") throw new Error("unexpected queue capacity failure");
  return result.workspace;
}

export function templateFixture() {
  return parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "pg-fixture", description: "pg" },
    spec: {
      version: "1.0.0",
      image: `example.test/pg@sha256:${"d".repeat(64)}`,
      harness: { command: ["sleep", "1"] },
      resources: { cpu: "1", memory: "256Mi" },
      services: {},
      persistence: { mounts: [{ name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 }] },
      outputs: { commit: { type: "gitSha" } },
    },
  });
}

export async function createPGliteFixture(prefix: string, mode: "memory" | "disk" = "memory") {
  const dir = mode === "disk" ? await mkdtemp(join(tmpdir(), `${prefix}-`)) : undefined;
  const context = await createDatabaseContext(dir);
  expect(await migrateDatabase(context.client)).toEqual([]);
  expect(
    (await getMigrationStatus(context.client)).every((migration) => migration.appliedAt && !migration.drifted),
  ).toBe(true);
  const store = new PGliteStore(context);
  const parsed = templateFixture();
  const principal = await store.createPrincipal("pg-test", ["admin"], ["*"]);
  const { row: template } = await store.upsertTemplate({
    name: "pg-fixture",
    version: "1.0.0",
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  return {
    parsed,
    principal,
    schema: context.schema,
    context,
    store,
    template,
    async query<T>(statement: string, params?: unknown[]) {
      return (await context.client.query<T>(statement, params)).rows;
    },
    async dispose() {
      await store.close();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
        await rm(`${dir}-journal`, { recursive: true, force: true });
      }
    },
  };
}

export async function insertTestWorkspace(
  fixture: Awaited<ReturnType<typeof createPGliteFixture>>,
  externalId: string,
  metadata: Record<string, string> = {},
) {
  return workspaceOf(
    await fixture.store.insertWorkspace({
      id: randomUUID(),
      principalId: fixture.principal.id,
      externalId,
      idempotencyKey: externalId,
      requestDigest: digestOf({ externalId }),
      templateId: fixture.template.id,
      templateSnapshot: snapshotOf(fixture.parsed),
      launchInput: { code: "opaque" },
      metadata,
      deadlineAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    }),
  );
}

type Cleanup = () => Promise<void>;
const cleanups = new WeakMap<Store, { jobs: Cleanup[]; resources: Cleanup[] }>();

export function registerTestCleanup(store: Store, cleanup: Cleanup, phase: "jobs" | "resources" = "jobs") {
  const callbacks = cleanups.get(store) ?? { jobs: [], resources: [] };
  callbacks[phase].push(cleanup);
  cleanups.set(store, callbacks);
}

export async function createTestStore() {
  const context = await createDatabaseContext();
  let store = new PGliteStore(context);
  const tables = Object.values(context.tables).map((table) => `"pocketcoder"."${getTableName(table)}"`);
  async function cleanup() {
    const callbacks = cleanups.get(store);
    for (const cleanup of callbacks?.jobs ?? []) await cleanup();
    for (const cleanup of callbacks?.resources ?? []) await cleanup();
    cleanups.delete(store);
  }
  return {
    get store() {
      return store;
    },
    async reset() {
      await cleanup();
      for (const id of context.changes.keys()) notifyChange(context, id);
      await context.client.exec(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
      store = new PGliteStore(context);
    },
    async dispose() {
      await cleanup();
      await store.close();
    },
  };
}

// Each test file owns its pool. Additional stores in one test stay independent.
export function createTestStoreFactory() {
  const fixtures: Array<Awaited<ReturnType<typeof createTestStore>>> = [];
  let next = 0;
  beforeEach(() => {
    next = 0;
  });
  afterEach(async () => {
    for (const fixture of fixtures) await fixture.reset();
  });
  afterAll(async () => {
    for (const fixture of fixtures) await fixture.dispose();
    fixtures.length = 0;
  });
  return async () => {
    const index = next++;
    fixtures[index] ??= await createTestStore();
    return fixtures[index].store;
  };
}
