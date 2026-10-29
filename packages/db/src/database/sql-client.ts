import type { PGlite, Transaction as PGliteTransaction } from "@electric-sql/pglite";
import type { SQL } from "bun";

// The small raw-SQL surface that migrations, operator commands and test fixtures share.
// Application queries use drizzle; this covers statements drizzle does not model.
export interface SqlClient {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  // Runs several statements without parameters, such as one migration file.
  exec(text: string): Promise<void>;
  // Nested calls reuse the open transaction.
  transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export function pgliteSqlClient(client: PGlite | PGliteTransaction): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await client.query<T>(text, params)).rows;
    },
    async exec(text) {
      await client.exec(text);
    },
    transaction(work) {
      if (!("transaction" in client)) return work(pgliteSqlClient(client));
      return client.transaction((tx) => work(pgliteSqlClient(tx)));
    },
  };
}

// Reserved connections and transactions are SQL clients too.
export function postgresSqlClient(client: SQL, inTransaction = false): SqlClient {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return [...((await client.unsafe(text, params ?? [])) as T[])];
    },
    async exec(text) {
      await client.unsafe(text);
    },
    async transaction<T>(work: (tx: SqlClient) => Promise<T>) {
      if (inTransaction) return work(this);
      return (await client.begin((tx) => work(postgresSqlClient(tx, true)))) as T;
    },
  };
}
