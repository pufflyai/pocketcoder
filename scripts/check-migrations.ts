import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RELEASE_081_MIGRATION } from "../packages/db/src/migrations/release-081";

type Shipped = Record<string, { hash: string; release: string }>;

const root = resolve(import.meta.dir, "..");
const folder = join(root, "packages/db/drizzle");
const manifestPath = join(root, "packages/db/shipped-migrations.json");

// Migrations an upgrade step reconciles instead of shipping them again (see packages/db/src/migrations).
const RECONCILED = { [RELEASE_081_MIGRATION.name]: RELEASE_081_MIGRATION.replacedBy };

function sha256(text: string) {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// Every database a release created must keep upgrading, so its migrations stay byte-identical.
export async function checkShippedMigrations(directory: string, shipped: Shipped, reconciled: Record<string, string>) {
  const present = new Set(await readdir(directory));
  const problems: string[] = [];
  for (const [name, { hash, release }] of Object.entries(shipped)) {
    if (!present.has(name)) {
      if (!(reconciled[name] && present.has(reconciled[name])))
        problems.push(`${name} (${release}) was removed after it shipped`);
      continue;
    }
    if (sha256(await readFile(join(directory, name, "migration.sql"), "utf8")) !== hash)
      problems.push(`${name} (${release}) changed after it shipped`);
  }
  return problems;
}

// Records the migrations of a release tag. Run after tagging a release that ships migrations.
async function record(tag: string, shipped: Shipped) {
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const listing = git(["ls-tree", "--name-only", tag, "packages/db/drizzle/"]);
  if (listing.exitCode !== 0) throw new Error(`unknown release tag ${tag}`);
  for (const path of listing.stdout.toString().trim().split("\n").filter(Boolean)) {
    const name = path.split("/").at(-1) as string;
    const sql = git(["show", `${tag}:${path}/migration.sql`]);
    if (sql.exitCode !== 0) continue;
    shipped[name] ??= { hash: sha256(sql.stdout.toString()), release: tag };
  }
}

if (import.meta.main) {
  const shipped: Shipped = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
  const tags = process.argv.slice(2);
  if (tags.length) {
    for (const tag of tags) await record(tag, shipped);
    const sorted = Object.fromEntries(Object.entries(shipped).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
  }
  const problems = await checkShippedMigrations(folder, shipped, RECONCILED);
  for (const problem of problems) console.error(`migration immutability: ${problem}`);
  if (problems.length) process.exit(1);
  console.log(`shipped migrations unchanged (${Object.keys(shipped).length})`);
}
