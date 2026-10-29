import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createPostgresTestDatabase, TEST_DATABASE_URL } from "./postgres-test-schema";
import { DatabaseStore } from "./store";
import { insertTestWorkspace, templateFixture } from "./test-fixtures";

// Code written since PC-58 only ran on single-connection PGlite. These tests open two
// controllers' worth of connections on one PostgreSQL database and race their claims.
async function sharedDatabase() {
  const database = await createPostgresTestDatabase("pc_race");
  const stores = await Promise.all(
    [0, 1].map(() => DatabaseStore.openPostgres({ url: database.url, schema: database.schema, max: 8 })),
  );
  const [first] = stores as [DatabaseStore, DatabaseStore];
  const parsed = templateFixture();
  const principal = await first.createPrincipal("race", ["admin"], ["*"]);
  const { row: template } = await first.upsertTemplate({
    name: "pg-fixture",
    version: "1.0.0",
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const fixture = { store: first, principal, template, parsed };
  return {
    stores,
    template,
    workspace: (name: string) => insertTestWorkspace(fixture as never, name),
    async dispose() {
      await Promise.all(stores.map((store) => store.close()));
      await database.drop();
    },
  };
}

const at = () => new Date();
const registration = () => ({
  registrationDigest: new Uint8Array([1, 2, 3]),
  registrationExpiresAt: new Date(Date.now() + 60_000),
});

describe.skipIf(!TEST_DATABASE_URL)("PostgreSQL concurrency", () => {
  test("racing admissions never exceed the global limit", async () => {
    const db = await sharedDatabase();
    try {
      const queued = [];
      for (let index = 0; index < 12; index++) queued.push(await db.workspace(`admit-${index}`));
      const limits = { globalActiveWorkspaces: 5, perPrincipalActiveWorkspaces: 100, perTemplateActiveWorkspaces: {} };
      const results = await Promise.all(
        queued.flatMap((workspace) =>
          db.stores.map((store) =>
            store.claimWorkspaceAdmission({ workspaceId: workspace.id, limits, at: at(), ...registration() }),
          ),
        ),
      );
      const admitted = results.filter((row) => row !== null);
      expect(admitted).toHaveLength(5);
      expect(new Set(admitted.map((row) => row.id)).size).toBe(5);
      expect((await db.stores[1]?.readAdmissionSnapshot())?.counts.global).toBe(5);
    } finally {
      await db.dispose();
    }
  }, 30_000);

  test("racing warm claims lease each ready runtime once", async () => {
    const db = await sharedDatabase();
    try {
      const runtimes = [];
      for (let index = 0; index < 3; index++) {
        const runtime = {
          id: randomUUID(),
          templateId: db.template.id,
          templateName: db.template.name,
          templateVersion: db.template.version,
          templateDigest: db.template.digest,
          driverKind: "docker",
          eligibilityFingerprint: "sha256:eligible",
          state: "ready" as const,
          providerRef: { kind: "docker", id: `warm-${index}` },
          enrollmentDigest: null,
          enrollmentExpiresAt: null,
          workspaceId: null,
          createdAt: at(),
          updatedAt: at(),
          readyAt: new Date(Date.now() + index),
          leasedAt: null,
          failureCode: null,
        };
        await db.stores[0]?.insertWarmPoolRuntime(runtime);
        runtimes.push(runtime);
      }
      const workspaces = [];
      for (let index = 0; index < 8; index++) workspaces.push(await db.workspace(`warm-${index}`));
      const claims = await Promise.all(
        workspaces.map((workspace, index) =>
          db.stores[index % 2]?.claimWarmPoolRuntime({
            workspace,
            driverKind: "docker",
            eligibilityFingerprint: "sha256:eligible",
            at: at(),
            ...registration(),
          }),
        ),
      );
      const leased = claims.filter((claim) => claim?.runtime);
      expect(leased).toHaveLength(3);
      expect(new Set(leased.map((claim) => claim?.runtime?.id))).toEqual(new Set(runtimes.map((row) => row.id)));
      expect(new Set(leased.map((claim) => claim?.workspace?.id)).size).toBe(3);
    } finally {
      await db.dispose();
    }
  }, 30_000);

  test("racing outbox claims deliver each event to one worker", async () => {
    const db = await sharedDatabase();
    try {
      const workspace = await db.workspace("outbox");
      for (let index = 0; index < 40; index++)
        await db.stores[0]?.appendEvent(workspace.id, "test.event", { index }, at());
      const due = new Date(Date.now() + 1000);
      const batches = await Promise.all(
        Array.from({ length: 8 }, (_, index) => db.stores[index % 2]?.claimDueEvents(due, 10) ?? []),
      );
      const ids = batches.flat().map((event) => event.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(40);
    } finally {
      await db.dispose();
    }
  }, 30_000);
});
