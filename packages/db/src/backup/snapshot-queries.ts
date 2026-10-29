import { type PGlite, protocol } from "@electric-sql/pglite";
import type { CheckpointStageIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createSchema } from "../schema";

// The snapshot holds both PGlite locks, so normal queries would wait on themselves.
// The wire protocol bypasses those locks; these statements are read-only apart from CHECKPOINT.
async function rows(client: PGlite, statement: string) {
  const { messages } = await client.execProtocol(protocol.serialize.query(statement));
  let names: string[] = [];
  const result: Record<string, string | null>[] = [];
  for (const message of messages) {
    if (message instanceof protocol.messages.RowDescriptionMessage) names = message.fields.map((field) => field.name);
    if (message instanceof protocol.messages.DataRowMessage)
      result.push(Object.fromEntries(names.map((name, index) => [name, message.fields[index] ?? null])));
  }
  return result;
}

function text(row: Record<string, string | null>, name: string) {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`Backup snapshot is missing ${name}.`);
  return value;
}

export async function requireSettledProviderLaunches(client: PGlite, schema: string) {
  const db = drizzle({ client });
  const { workspaces, warmPoolRuntimes: warm } = createSchema(schema);
  // Fixed literals let these schema-backed queries use the lock-safe simple protocol.
  const workspace = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.state, sql`'provisioning'`), isNull(workspaces.providerRef)))
    .toSQL();
  const pool = db
    .select({ id: warm.id })
    .from(warm)
    .where(and(eq(warm.state, sql`'provisioning'`), isNull(warm.providerRef)))
    .toSQL();
  if ((await rows(client, workspace.sql)).length || (await rows(client, pool.sql)).length)
    throw new Error("Provider launches have not settled. Retry the off-node backup.");
}

export async function readSnapshotState(client: PGlite, schema: string, requireSettledProviders = false) {
  if (requireSettledProviders) await requireSettledProviderLaunches(client, schema);
  // Flush every committed page so the copied files need no log replay to be current.
  await rows(client, "CHECKPOINT");
  const [position] = await rows(client, "SELECT pg_current_wal_lsn()::text AS position");
  // Provider-held checkpoints, such as Kubernetes volumes, live outside the controller.
  const [external] = await rows(
    client,
    `SELECT provider_kind FROM "${schema}"."workspace_checkpoints"
      WHERE provider_kind <> 'controller-archive' AND provider_ref IS NOT NULL AND state <> 'deleted'
      LIMIT 1`,
  );
  if (external)
    throw new Error(
      `Backup cannot capture ${external.provider_kind} checkpoints; only controller archives are supported.`,
    );
  return {
    position: text(position ?? {}, "position"),
    migrations: await readMigrations(client, schema),
    publications: await readPublications(client, schema),
  };
}

export async function readJournalId(client: PGlite, schema: string) {
  const [row] = await rows(
    client,
    `SELECT journal->>'journalId' AS journal_id FROM "${schema}"."checkpoint_controller_state" WHERE id = 'controller'`,
  );
  return row?.journal_id ?? null;
}

export async function readMigrations(client: PGlite, schema: string) {
  const applied = await rows(
    client,
    `SELECT name, hash FROM "${schema}"."__drizzle_migrations" ORDER BY created_at, id`,
  );
  return applied.map((row) => ({ name: text(row, "name"), hash: text(row, "hash") }));
}

// Every upload with a stage path names a file in the checkpoint directory.
export async function readPublications(client: PGlite, schema: string) {
  const uploads = await rows(
    client,
    `SELECT id, checkpoint_id, state, stage_path, stage_identity::text AS stage_identity,
            archive_digest, stored_bytes::text AS stored_bytes
       FROM "${schema}"."checkpoint_transfers"
      WHERE direction = 'upload' AND stage_path IS NOT NULL
      ORDER BY id`,
  );
  return uploads.map((row) => {
    if (row.state !== "complete") throw new Error("Checkpoint transfers have not settled.");
    return {
      transferId: text(row, "id"),
      checkpointId: text(row, "checkpoint_id"),
      name: text(row, "stage_path"),
      identity: JSON.parse(text(row, "stage_identity")) as CheckpointStageIdentity,
      digest: text(row, "archive_digest"),
      bytes: Number(text(row, "stored_bytes")),
    };
  });
}
export type Publication = Awaited<ReturnType<typeof readPublications>>[number];
