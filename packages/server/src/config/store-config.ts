import { assertValidSchema } from "@pstdio/pocketcoder-db";

type Environment = Record<string, string | undefined>;

export type StoreConfig = { kind: "pglite" } | { kind: "postgres"; databaseUrl: string; databaseSchema: string };

// A database URL means a server deployment, so it selects PostgreSQL unless told otherwise.
// Without one, local and desktop runs keep the embedded store.
export function storeKind(env: Environment) {
  const kind = env.POCKETCODER_STORE ?? (env.POCKETCODER_DATABASE_URL ? "postgres" : "pglite");
  if (kind !== "postgres" && kind !== "pglite") throw new Error("POCKETCODER_STORE must be one of: postgres, pglite");
  return kind;
}

// Operator commands such as `pcd db migrate` need only the database location.
export function databaseLocation(env: Environment) {
  const databaseUrl = env.POCKETCODER_DATABASE_URL;
  if (!databaseUrl) throw new Error("POCKETCODER_DATABASE_URL is required (or set POCKETCODER_STORE=pglite)");
  return { databaseUrl, databaseSchema: assertValidSchema(env.POCKETCODER_DATABASE_SCHEMA ?? "pocketcoder") };
}

export function storeConfig(env: Environment): StoreConfig {
  const kind = storeKind(env);
  if (kind === "pglite") return { kind };
  const location = databaseLocation(env);
  // Machine key digests use this pepper, so an upgraded database needs the one it was written with.
  if (!env.POCKETCODER_AUTH_PEPPER) throw new Error("POCKETCODER_AUTH_PEPPER is required with PostgreSQL");
  // The journal lets a restored database reapply revocations and deletions made after its backup.
  if (!env.POCKETCODER_JOURNAL_DIR) throw new Error("POCKETCODER_JOURNAL_DIR is required with PostgreSQL");
  if (env.POCKETCODER_OFF_NODE_CONFIG)
    throw new Error("Off-node backup is not available with PostgreSQL. Use your database's backups instead.");
  return { kind, ...location };
}
