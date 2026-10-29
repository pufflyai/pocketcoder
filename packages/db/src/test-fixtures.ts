import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceInsertResult } from "@pstdio/pocketcoder-runtime-core";
import { getTableName } from "drizzle-orm";
import { notifyChange } from "./database/context";
import { createPGliteContext } from "./database/pglite-context";
import { getMigrationStatus, migrateDatabase } from "./migrations/migrator";
import { createPostgresTestDatabase, TEST_STORE_DRIVER } from "./postgres-test-schema";
import { DatabaseStore } from "./store";

export { objectStorageFixture } from "./off-node/object-storage-fixture";
export { createPostgresTestDatabase, TEST_DATABASE_URL, TEST_STORE_DRIVER } from "./postgres-test-schema";

// PGlite reports the SQLSTATE as `code`; Bun's PostgreSQL client reports it as `errno`.
export function sqlStateOf(error: unknown) {
  const cause = (error as { cause?: { code?: string; errno?: string } } | undefined)?.cause;
  return cause?.errno ?? cause?.code;
}

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

// Opens a migrated store on the driver selected for this test run. Disk mode is a PGlite data folder.
async function openTestDatabase(prefix: string, mode: "memory" | "disk") {
  if (mode === "memory" && TEST_STORE_DRIVER === "postgres") {
    const database = await createPostgresTestDatabase(prefix);
    const store = await DatabaseStore.openPostgres(database);
    return { directory: undefined, context: store.context, store, drop: database.drop };
  }
  const dir = mode === "disk" ? await mkdtemp(join(tmpdir(), `${prefix}-`)) : undefined;
  const context = await createPGliteContext(dir);
  const drop = async () => {
    if (!dir) return;
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-journal`, { recursive: true, force: true });
  };
  return { directory: dir, context, store: new DatabaseStore(context), drop };
}

export async function createPGliteFixture(prefix: string, mode: "memory" | "disk" = "memory") {
  const { directory, context, store, drop } = await openTestDatabase(prefix, mode);
  expect(await migrateDatabase(context.sql, undefined, context.schema)).toEqual([]);
  expect(
    (await getMigrationStatus(context.sql, context.schema)).every(
      (migration) => migration.appliedAt && !migration.drifted,
    ),
  ).toBe(true);
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
    directory,
    parsed,
    principal,
    schema: context.schema,
    context,
    store,
    template,
    async query<T>(statement: string, params?: unknown[]) {
      return context.sql.query<T>(statement, params);
    },
    async dispose() {
      await store.close();
      await drop();
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
  const { context, store: first, drop } = await openTestDatabase("pc_store", "memory");
  let store = first;
  const tables = Object.values(context.tables).map((table) => `"${context.schema}"."${getTableName(table)}"`);
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
      if (context.driver === "postgres") await context.releaseCoordinatorLease();
      await context.sql.exec(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
      store = new DatabaseStore(context);
    },
    async dispose() {
      await cleanup();
      await store.close();
      await drop();
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

export { executionFixture } from "./modules/workspaces/execution-fixture.test";

export {
  executionConversationIdentity,
  serviceExecutionTemplate,
} from "./modules/workspaces/execution-service-fixture.test";
