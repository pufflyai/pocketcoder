import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseStore } from "@pstdio/pocketcoder-db";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { databaseLocation, storeKind } from "@pstdio/pocketcoder-server/store-config";
import { parse as parseDotenv } from "dotenv";

export interface Flags {
  [key: string]: unknown;
}

export function need(flags: Flags, key: string): string {
  const value = flags[key];
  if (typeof value !== "string" || value === "") fail(`missing required flag --${key}`);
  return value;
}

export function valueList(value: string) {
  return value.split(",").map((item) => item.trim());
}

export function fail(message: string): never {
  console.error(`pcd: ${message}`);
  process.exit(1);
}

function findEnvironmentFile(startDirectory: string) {
  let directory = resolve(startDirectory);
  while (true) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export function loadProjectEnvironment(flags: Flags): void {
  const workdirValue = flags.workdir;
  const workdir =
    typeof workdirValue === "string" && workdirValue !== "" ? resolve(process.cwd(), workdirValue) : process.cwd();
  try {
    if (!statSync(workdir).isDirectory()) fail(`work directory is not a directory: ${workdir}`);
  } catch {
    fail(`work directory does not exist: ${workdir}`);
  }
  if (typeof workdirValue === "string") process.chdir(workdir);

  const envFileValue = flags["env-file"];
  const explicitEnvFile =
    typeof envFileValue === "string" && envFileValue !== "" ? resolve(workdir, envFileValue) : undefined;
  const envFile = explicitEnvFile ?? findEnvironmentFile(workdir);
  if (!envFile) return;
  if (explicitEnvFile && !existsSync(explicitEnvFile)) {
    fail(`environment file does not exist: ${explicitEnvFile}`);
  }
  try {
    const parsed = parseDotenv(readFileSync(envFile));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    fail(`could not read environment file ${envFile}: ${error instanceof Error ? error.message : error}`);
  }
}

export function controlPlaneClient() {
  const url = process.env.POCKETCODER_URL ?? "http://127.0.0.1:8090";
  const apiKey = process.env.POCKETCODER_KEY;
  if (!apiKey) fail("POCKETCODER_KEY is required for this command");
  return new PocketCoderClient({ baseUrl: url, apiKey });
}

export async function api(path: string, init: RequestInit = {}) {
  return await controlPlaneClient().raw(path, init);
}

// Folder backups, off-node backups and folder recovery copy the embedded data folder.
export function requireEmbeddedStore(command: string) {
  if (storeKind(process.env) === "postgres")
    fail(`${command} is not available with PostgreSQL. Use your database's backups instead.`);
}

// Opens the configured store while the server is stopped; both hold the same writer locks.
export async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const journalDir = process.env.POCKETCODER_JOURNAL_DIR;
  const store =
    storeKind(process.env) === "postgres"
      ? await DatabaseStore.openPostgres({
          url: databaseLocation(process.env).databaseUrl,
          schema: databaseLocation(process.env).databaseSchema,
          ...(journalDir ? { journalDir } : {}),
          max: 1,
        })
      : await DatabaseStore.openPGlite(process.env.POCKETCODER_DIR ?? "./pc_data", journalDir ? { journalDir } : {});
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
