import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import migrations from "../../assets/migrations.json" with { type: "json" };
import { pgliteSqlClient } from "../database/sql-client";
import { getMigrationStatus, migrateDatabase } from "./migrator";
import { RELEASE_081_MIGRATION } from "./release-081";

const shared = migrations.slice(0, 8);

async function previousRelease(release: "0.8.0" | "0.8.1") {
  const client = await PGlite.create({ postgresqlconf: ["shared_buffers = 16MB"] });
  const sql = pgliteSqlClient(client);
  await migrateDatabase(sql, shared);
  if (release === "0.8.1") {
    for (const statement of RELEASE_081_MIGRATION.sql)
      await client.exec(`SET search_path TO pocketcoder; ${statement}`);
    await client.query(`INSERT INTO pocketcoder.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)`, [
      RELEASE_081_MIGRATION.hash,
      1791896323000,
      RELEASE_081_MIGRATION.name,
    ]);
  }
  return { client, sql };
}

test.each(["0.8.0", "0.8.1"] as const)("a %s history upgrades to the full 1.0 chain", async (release) => {
  const { client, sql } = await previousRelease(release);
  try {
    if (release === "0.8.1") {
      const status = await getMigrationStatus(sql);
      expect(status.find((row) => row.name === RELEASE_081_MIGRATION.replacedBy)?.appliedAt).toBeNull();
    }
    const applied = await migrateDatabase(sql);
    expect(applied).toEqual(migrations.slice(8).map((migration) => migration.name));
    const history = await sql.query<{ name: string; hash: string }>(
      "SELECT name, hash FROM pocketcoder.__drizzle_migrations ORDER BY created_at, id",
    );
    expect(history).toEqual(migrations.map(({ name, hash }) => ({ name, hash })));
    expect((await getMigrationStatus(sql)).every((row) => row.appliedAt)).toBe(true);
    const constraints = await sql.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conname = 'workspaces_reason_code_check'",
    );
    expect(constraints).toHaveLength(1);
    expect(await migrateDatabase(sql)).toEqual([]);
  } finally {
    await client.close();
  }
});

test("a changed 0.8.1 migration is drift, not an upgrade", async () => {
  const { client, sql } = await previousRelease("0.8.1");
  try {
    await client.exec(
      `UPDATE pocketcoder.__drizzle_migrations SET hash = 'changed' WHERE name = '${RELEASE_081_MIGRATION.name}'`,
    );
    await expect(migrateDatabase(sql)).rejects.toThrow("checksum drift");
  } finally {
    await client.close();
  }
});

test("upgrading a 0.x database decodes JSON stored inside jsonb strings", async () => {
  const { client, sql } = await previousRelease("0.8.0");
  try {
    const spec = { image: "example", resources: { cpu: "1" } };
    await client.query(
      `INSERT INTO pocketcoder.templates (id, name, version, digest, spec, status, created_at)
       VALUES (gen_random_uuid(), 'legacy', '1.0.0', 'sha256:legacy', to_jsonb($1::text), 'active', now())`,
      [JSON.stringify(spec)],
    );
    await migrateDatabase(sql);
    const [row] = await sql.query<{ kind: string; spec: unknown }>(
      "SELECT jsonb_typeof(spec) AS kind, spec FROM pocketcoder.templates WHERE name = 'legacy'",
    );
    expect(row).toEqual({ kind: "object", spec });
  } finally {
    await client.close();
  }
});

test("a 0.8 upgrade keeps a live name-only Kubernetes reference for the controller to recover", async () => {
  const { client, sql } = await previousRelease("0.8.0");
  const id = crypto.randomUUID();
  const ref = { kind: "kubernetes", id: `pocketcoder-ws-${id}`, namespace: "alpha" };
  try {
    await client.exec(`
      INSERT INTO pocketcoder.principals (id, name, scopes, template_names, created_at)
        VALUES ('${id}', 'legacy', '{}', '{}', now());
      INSERT INTO pocketcoder.templates (id, name, version, digest, spec, status, created_at)
        VALUES ('${id}', 'legacy', '1', 'sha256:legacy', '{}', 'active', now());
    `);
    await client.query(
      `INSERT INTO pocketcoder.workspaces
      (id, principal_id, external_id, idempotency_key, request_digest, template_id, template_name,
       template_version, template_digest, template_snapshot, state, provider_kind, provider_ref, deadline_at, created_at, updated_at)
      VALUES ($1, $1, 'legacy', 'legacy', 'legacy', $1, 'legacy', '1', 'sha256:legacy', '{}',
        'terminating', 'kubernetes', $2::jsonb, now(), now(), now())`,
      [id, JSON.stringify(JSON.stringify(ref))],
    );
    expect(await migrateDatabase(sql)).toEqual(migrations.slice(8).map((migration) => migration.name));
    const [row] = await sql.query<{ provider_ref: unknown }>(
      "SELECT provider_ref FROM pocketcoder.workspaces WHERE id = $1",
      [id],
    );
    expect(row?.provider_ref).toEqual(ref);
  } finally {
    await client.close();
  }
});
