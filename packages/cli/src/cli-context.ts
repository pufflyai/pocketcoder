import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PostgresStore } from "@pstdio/pocketcoder-db";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
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
    typeof workdirValue === "string" && workdirValue !== ""
      ? resolve(process.cwd(), workdirValue)
      : process.cwd();
  try {
    if (!statSync(workdir).isDirectory()) fail(`work directory is not a directory: ${workdir}`);
  } catch {
    fail(`work directory does not exist: ${workdir}`);
  }
  if (typeof workdirValue === "string") process.chdir(workdir);

  const envFileValue = flags["env-file"];
  const explicitEnvFile =
    typeof envFileValue === "string" && envFileValue !== ""
      ? resolve(workdir, envFileValue)
      : undefined;
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
    fail(
      `could not read environment file ${envFile}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export function dbConfig() {
  const url = process.env.POCKETCODER_DATABASE_URL;
  if (!url) fail("POCKETCODER_DATABASE_URL is required for this command");
  return { url, schema: process.env.POCKETCODER_DATABASE_SCHEMA ?? "pocketcoder" };
}

export function controlPlaneClient() {
  const url = process.env.POCKETCODER_URL ?? "http://127.0.0.1:7080";
  const apiKey = process.env.POCKETCODER_KEY;
  if (!apiKey) fail("POCKETCODER_KEY is required for this command");
  return new PocketCoderClient({ baseUrl: url, apiKey });
}

export async function api(path: string, init: RequestInit = {}) {
  return await controlPlaneClient().raw(path, init);
}

export async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const { url, schema } = dbConfig();
  const store = new PostgresStore(url, schema);
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}
