import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { assertValidSchema } from "../database-schema";
import { getMigrationStatus } from "../migrations/migrator";
import { createSchema } from "../schema";

export function createDatabaseContext(databaseUrl: string, schemaName: string) {
  const schema = assertValidSchema(schemaName);
  const client = new SQL(databaseUrl);
  return {
    schema,
    client,
    db: drizzle({ client }),
    tables: createSchema(schema),
    changes: new Map<string, Set<() => void>>(),
  };
}
export type DatabaseContext = ReturnType<typeof createDatabaseContext>;
export type Transaction = Parameters<Parameters<DatabaseContext["db"]["transaction"]>[0]>[0];
export type QueryContext = DatabaseContext["db"] | Transaction;

// PostgreSQL advisory locks serialize limits that span several rows.
export async function lock(tx: Transaction, name: string, seed: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, ${seed}))`);
}

export function notifyChange(context: DatabaseContext, id: string) {
  const waiters = context.changes.get(id);
  context.changes.delete(id);
  for (const resolve of waiters ?? []) resolve();
}

export function createLifecycle(context: DatabaseContext) {
  const { client, schema } = context;
  let coordinatorRelease: (() => Promise<void>) | null = null;
  return {
    async init() {
      const status = await getMigrationStatus(client, schema);
      const drifted = status.filter((row) => row.drifted);
      if (drifted.length)
        throw new Error(
          `database schema ${schema} has migration checksum drift: ${drifted.map((row) => row.name).join(", ")}`,
        );
      const pending = status.filter((row) => row.appliedAt === null);
      if (pending.length)
        throw new Error(
          `database schema ${schema} has pending migrations: ${pending.map((row) => row.name).join(", ")}; run pcd db migrate`,
        );
    },
    async acquireCoordinatorLease() {
      if (coordinatorRelease) throw new Error("a PocketCoder coordinator is already active");
      // Session locks must stay on a reserved connection until released.
      const connection = await client.reserve();
      const name = `${schema}:coordinator`;
      const rows = await connection`SELECT pg_try_advisory_lock(hashtextextended(${name}, 7351)) AS acquired`;
      if (!rows[0]?.acquired) {
        connection.release();
        throw new Error(`a PocketCoder coordinator is already active for schema ${schema}`);
      }
      const release = async () => {
        if (coordinatorRelease !== release) return;
        await connection`SELECT pg_advisory_unlock(hashtextextended(${name}, 7351))`;
        connection.release();
        coordinatorRelease = null;
      };
      coordinatorRelease = release;
      return release;
    },
    async close() {
      await coordinatorRelease?.();
      for (const id of context.changes.keys()) notifyChange(context, id);
      await client.end();
    },
  };
}
