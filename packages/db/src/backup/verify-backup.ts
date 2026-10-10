import { closeSync, constants, fstatSync, mkdtempSync, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import seed from "../../assets/core-seed.json" with { type: "json" };
import { loadCoreAssets } from "../database/assets";
import { scanArchive } from "./archive-reader";
import { KEY_NAMES } from "./manifest";
import { readMigrations, readPublications } from "./snapshot-queries";

async function readDatabase(directory: string) {
  const assets = await loadCoreAssets();
  const client = await PGlite.create({
    pgliteWasmModule: assets.pgliteWasmModule,
    fsBundle: assets.fsBundle,
    fs: new NodeFS(directory),
  });
  try {
    return {
      migrations: await readMigrations(client, "pocketcoder"),
      publications: await readPublications(client, "pocketcoder"),
    };
  } finally {
    await client.close();
  }
}

// Checks a backup using only the archive: structure, digests, keys and the database's own references.
export async function verifyBackup(path: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const scratch = mkdtempSync(join(tmpdir(), "pocketcoder-verify-"));
  try {
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new Error("Backup archive must be a regular file.");
    const { manifest, members } = await scanArchive(file, stat.size, scratch);
    if (!isDeepStrictEqual(manifest.members, members)) throw new Error("Backup members differ from the manifest.");
    if (manifest.engine.pglite !== seed.pgliteVersion || manifest.engine.postgres !== seed.postgresVersion)
      throw new Error("Backup database engine differs from this PocketCoder build.");
    for (const name of KEY_NAMES) {
      const key = members.find((member) => member.path === `keys/${name}`);
      if (key?.type !== "file" || key.bytes !== 32) throw new Error(`Backup key is missing or malformed: ${name}`);
    }
    const archived = members.flatMap((member) =>
      member.type === "file" && member.path.startsWith("checkpoints/")
        ? [{ path: member.path, bytes: member.bytes, digest: member.digest }]
        : [],
    );
    const database = await readDatabase(join(scratch, "db"));
    const known = seed.migrations.slice(0, database.migrations.length);
    if (
      !isDeepStrictEqual(database.migrations, manifest.database.migrations) ||
      !isDeepStrictEqual(database.migrations, known)
    )
      throw new Error("Backup database format is unknown to this PocketCoder build.");
    const referenced = database.publications.map((publication) => ({
      checkpointId: publication.checkpointId,
      transferId: publication.transferId,
      path: `checkpoints/${publication.name}`,
      bytes: publication.bytes,
      digest: publication.digest,
    }));
    const listed = manifest.checkpoints.map(({ path, bytes, digest }) => ({ path, bytes, digest }));
    // The database snapshot, the manifest and the copied bytes must name the same archives.
    if (!isDeepStrictEqual(referenced, manifest.checkpoints) || !isDeepStrictEqual(archived, listed))
      throw new Error("Backup checkpoint archives differ from the database references.");
    return { manifest, bytes: stat.size };
  } finally {
    closeSync(file);
    await rm(scratch, { recursive: true, force: true });
  }
}
