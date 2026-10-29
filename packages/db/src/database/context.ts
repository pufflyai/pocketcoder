import type { PGlite } from "@electric-sql/pglite";
import type { SourceWriter } from "@pstdio/pocketcoder-contracts";
import type { SQL } from "bun";
import { sql } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { DatabaseBudget } from "../backup/bounded-filesystem";
import type { JournalAcknowledgement } from "../journal/acknowledgement";
import type { DeletionJournal } from "../journal/journal";
import type { createSchema } from "../schema";
import type { SqlClient } from "./sql-client";

export interface DatabaseOpenOptions {
  databaseBudget?: DatabaseBudget;
  beforeOpen?(directory: string): Promise<void>;
  // Defaults to the folder recorded in the database, then to "<data folder>-journal".
  journalDir?: string;
  acknowledgeJournal?: JournalAcknowledgement;
}

interface SharedContext {
  schema: string;
  sql: SqlClient;
  db: PgAsyncDatabase<PgQueryResultHKT>;
  tables: ReturnType<typeof createSchema>;
  journal: DeletionJournal | undefined;
  changes: Map<string, Set<() => void>>;
  close(): Promise<void>;
}

// The embedded engine owns a private data folder, so it also fences writers by that folder.
export interface PGliteContext extends SharedContext {
  driver: "pglite";
  client: PGlite;
  dataWriter: SourceWriter | undefined;
  acknowledgeJournal: JournalAcknowledgement | undefined;
  dataDir: string | undefined;
  validateStorage: (() => void) | undefined;
}

// A PostgreSQL server owns durability and backups. The coordinator lease fences writers.
export interface PostgresContext extends SharedContext {
  driver: "postgres";
  client: SQL;
  acquireCoordinatorLease(): Promise<() => Promise<void>>;
  releaseCoordinatorLease(): Promise<void>;
  dataWriter?: undefined;
  acknowledgeJournal?: undefined;
  dataDir?: undefined;
  validateStorage?: undefined;
}

export type DatabaseContext = PGliteContext | PostgresContext;
export type Transaction = Parameters<Parameters<DatabaseContext["db"]["transaction"]>[0]>[0];
export type QueryContext = DatabaseContext["db"] | Transaction;

// Folder snapshots, off-node backups and writer fencing need the embedded data folder.
export function requirePGlite(context: DatabaseContext, feature: string): PGliteContext {
  if (context.driver !== "pglite")
    throw new Error(`${feature} is not available with PostgreSQL. Use your database's backups instead.`);
  return context;
}

// Row-spanning limits stay atomic: the advisory lock serializes transactions on one key.
export async function lock(tx: Transaction, name: string, seed: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, ${seed}))`);
}

export function notifyChange(context: DatabaseContext, id: string) {
  const waiters = context.changes.get(id);
  context.changes.delete(id);
  for (const resolve of waiters ?? []) resolve();
}

export function createLifecycle(context: DatabaseContext) {
  let coordinator = false;
  return {
    async init() {},
    async acquireCoordinatorLease() {
      if (context.driver === "postgres") return context.acquireCoordinatorLease();
      // The data folder lock already excludes other processes; this excludes a second coordinator here.
      if (coordinator) throw new Error("a PocketCoder coordinator is already active");
      coordinator = true;
      return async () => {
        coordinator = false;
      };
    },
    async close() {
      for (const id of context.changes.keys()) notifyChange(context, id);
      await context.close();
    },
  };
}
