import { expect, test } from "bun:test";
import { createPGliteFixture, insertTestWorkspace } from "../test-fixtures";
import { migrateDatabase } from "./migrator";

test.each(["object", "encoded"])("migration rejects a live name-only Kubernetes reference (%s)", async (encoding) => {
  const f = await createPGliteFixture("legacy-kubernetes");
  try {
    const workspace = await insertTestWorkspace(f, "legacy");
    const ref = { kind: "kubernetes", id: `pocketcoder-${workspace.id}`, namespace: "alpha" };
    await f.query(
      `UPDATE "${f.schema}".workspaces SET state = 'terminating', provider_kind = 'kubernetes', provider_ref = ($1::text)::jsonb WHERE id = $2`,
      [JSON.stringify(encoding === "encoded" ? JSON.stringify(ref) : ref), workspace.id],
    );
    const before = await f.query(`SELECT * FROM "${f.schema}".__drizzle_migrations ORDER BY id`);
    await expect(migrateDatabase(f.context.sql, undefined, f.schema)).rejects.toThrow(`workspace ${workspace.id}`);
    expect(await f.query(`SELECT * FROM "${f.schema}".__drizzle_migrations ORDER BY id`)).toEqual(before);
  } finally {
    await f.dispose();
  }
});

test.each([
  { name: "ended Kubernetes history", state: "canceled" as const, kind: "kubernetes", extra: {} },
  { name: "bound live Job", state: "terminating" as const, kind: "kubernetes", extra: { jobUid: "original-uid" } },
  {
    name: "never admitted launch",
    state: "terminating" as const,
    kind: "kubernetes",
    extra: {
      terminationEvidence: {
        neverAdmitted: { inputUid: "receipt-uid", workspaceId: "workspace", templateDigest: "digest" },
      },
    },
  },
  { name: "another provider", state: "terminating" as const, kind: "docker", extra: {} },
])("migration accepts $name", async ({ state, kind, extra }) => {
  const f = await createPGliteFixture("kubernetes-upgrade-safe");
  try {
    const workspace = await insertTestWorkspace(f, "safe");
    await f.store.transition(workspace.id, {
      from: ["queued"],
      to: "provisioning",
      at: new Date(),
      patch: { providerKind: kind, providerRef: { kind, id: "provider", ...extra } },
    });
    await f.store.transition(workspace.id, { from: ["provisioning"], to: state, at: new Date() });
    expect(await migrateDatabase(f.context.sql, undefined, f.schema)).toEqual([]);
  } finally {
    await f.dispose();
  }
});
