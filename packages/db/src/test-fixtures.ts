import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceInsertResult } from "@pstdio/pocketcoder-runtime-core";
import { SQL } from "bun";
import { getMigrationStatus, migrateDatabase } from "./migrations/migrator";
import { PostgresStore } from "./store";

// Shared by the command and public store integration suites.
export const TEST_DATABASE_URL = process.env.POCKETCODER_TEST_DATABASE_URL;

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
      persistence: {
        mounts: [{ name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 }],
      },
      outputs: { commit: { type: "gitSha" } },
    },
  });
}

export async function createPostgresFixture(prefix: string) {
  const url = TEST_DATABASE_URL as string;
  const schema = `${prefix}_${randomUUID().slice(0, 8)}`;
  const sql = new SQL(url);
  await migrateDatabase(sql, schema);
  expect(await migrateDatabase(sql, schema)).toEqual([]);
  const status = await getMigrationStatus(sql, schema);
  expect(status.every((migration) => migration.appliedAt !== null && !migration.drifted)).toBe(
    true,
  );
  const store = new PostgresStore(url, schema);
  await store.init();
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
    schema,
    sql,
    store,
    template,
    async dispose() {
      await store.close();
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    },
  };
}

export async function insertTestWorkspace(
  fixture: Awaited<ReturnType<typeof createPostgresFixture>>,
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
