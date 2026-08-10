import { cp, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error("an output directory is required");

const repositoryRoot = resolve(import.meta.dir, "..");
const outputDirectory = isAbsolute(outputArgument)
  ? outputArgument
  : resolve(process.cwd(), outputArgument);
const migrationsDirectory = resolve(outputDirectory, "drizzle");

if (!outputDirectory.startsWith(repositoryRoot)) {
  throw new Error("migration assets must stay inside the repository");
}

await rm(migrationsDirectory, { recursive: true, force: true });
await cp(resolve(repositoryRoot, "packages/db/drizzle"), migrationsDirectory, { recursive: true });
