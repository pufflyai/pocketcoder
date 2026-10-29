import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { assertValidSchema } from "../database-schema";
import { openJournal } from "../journal/journal";
import { getMigrationStatus } from "../migrations/migrator";
import { createSchema } from "../schema";
import type { PostgresContext } from "./context";
import { postgresSqlClient } from "./sql-client";

export interface PostgresOptions {
  url: string;
  schema?: string;
  // The deletion journal survives a database restore, so the controller can reapply it.
  journalDir?: string;
  max?: number;
}

// Startup never migrates a shared database. Operators run `pcd db migrate` first.
export async function assertMigrated(client: SQL, schema: string) {
  const pending = (await getMigrationStatus(postgresSqlClient(client), schema)).filter((row) => !row.appliedAt);
  if (pending.length)
    throw new Error(
      `database schema ${schema} has pending migrations: ${pending.map((row) => row.name).join(", ")}; run pcd db migrate`,
    );
}

async function bindPostgresJournal(context: PostgresContext, directory: string) {
  const { db, tables } = context;
  const [state] = await db
    .insert(tables.controllerState)
    .values({ id: "controller", sourceWriter: null, recovery: null })
    .onConflictDoUpdate({ target: tables.controllerState.id, set: { id: "controller" } })
    .returning();
  const bound = state?.journal ?? null;
  const journal = openJournal(directory, undefined, !bound);
  try {
    if (bound && bound.journalId !== journal.id)
      throw new Error(`This database belongs to deletion journal ${bound.journalId}, not ${journal.directory}.`);
    if (bound?.directory !== journal.directory)
      await db
        .update(tables.controllerState)
        .set({ journal: { journalId: journal.id, directory: journal.directory } })
        .where(eq(tables.controllerState.id, "controller"));
    return journal;
  } catch (error) {
    journal.close();
    throw error;
  }
}

export async function createPostgresContext(options: PostgresOptions): Promise<PostgresContext> {
  const schema = assertValidSchema(options.schema ?? "pocketcoder");
  const client = new SQL(options.url, { max: options.max ?? 10 });
  let coordinator: (() => Promise<void>) | undefined;
  try {
    await assertMigrated(client, schema);
    const context: PostgresContext = {
      driver: "postgres",
      schema,
      client,
      sql: postgresSqlClient(client),
      db: drizzle({ client }),
      tables: createSchema(schema),
      journal: undefined,
      changes: new Map(),
      async acquireCoordinatorLease() {
        if (coordinator) throw new Error("a PocketCoder coordinator is already active");
        // A session lock lives as long as its connection, so it stays on one reserved connection.
        const connection = await client.reserve();
        const name = `${schema}:coordinator`;
        const rows = await connection`SELECT pg_try_advisory_lock(hashtextextended(${name}, 7351)) AS acquired`;
        if (!rows[0]?.acquired) {
          connection.release();
          throw new Error(`a PocketCoder coordinator is already active for schema ${schema}`);
        }
        const release = async () => {
          if (coordinator !== release) return;
          coordinator = undefined;
          try {
            await connection`SELECT pg_advisory_unlock(hashtextextended(${name}, 7351))`;
          } finally {
            connection.release();
          }
        };
        coordinator = release;
        return release;
      },
      async releaseCoordinatorLease() {
        await coordinator?.();
      },
      async close() {
        try {
          await coordinator?.();
        } finally {
          context.journal?.close();
          await client.end();
        }
      },
    };
    if (options.journalDir) context.journal = await bindPostgresJournal(context, options.journalDir);
    return context;
  } catch (error) {
    await client.end();
    throw error;
  }
}
