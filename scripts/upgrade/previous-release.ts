import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} failed (${code}): ${stderr || stdout}`);
  return stdout;
}

// The tagged source of a shipped release with its locked dependencies, cached between runs.
export async function previousRelease(tag: string) {
  const directory = join(tmpdir(), "pocketcoder-releases", tag.replaceAll(/[@/]/g, "_"));
  if (existsSync(join(directory, "node_modules"))) return directory;
  const stage = `${directory}.staging`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await run(["sh", "-c", `git archive "$1" | tar -x -C "$2"`, "archive", tag, stage], root);
  await run(["bun", "install", "--frozen-lockfile"], stage);
  await rm(directory, { recursive: true, force: true });
  await rename(stage, directory);
  return directory;
}

// Applies that release's migrations with its own `pcd db migrate`.
export async function migrateWithRelease(directory: string, databaseUrl: string) {
  await run(["bun", "--no-env-file", "packages/cli/src/index.ts", "db", "migrate"], directory, {
    POCKETCODER_DATABASE_URL: databaseUrl,
    POCKETCODER_DATABASE_SCHEMA: "pocketcoder",
  });
}

export interface SeededRelease {
  principalId: string;
  token: string;
  keyId: string;
  endedWorkspaceId: string;
  queuedWorkspaceId: string;
  checkpointId: string;
  conversationId: string | null;
}

// Writes principals, keys, templates, workspaces and history through that release's store.
export async function seedWithRelease(directory: string, databaseUrl: string, pepper: string) {
  // The server package of every release depends on the store, auth and contract packages.
  const script = join(directory, "packages/server/pocketcoder-upgrade-seed.ts");
  await copyFile(join(import.meta.dir, "seed-previous-release.ts"), script);
  const output = await run(["bun", "--no-env-file", script], directory, {
    SEED_DATABASE_URL: databaseUrl,
    SEED_PEPPER: pepper,
  });
  return JSON.parse(output.trim().split("\n").at(-1) as string) as SeededRelease;
}
