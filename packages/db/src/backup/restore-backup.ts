import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PGlite } from "@electric-sql/pglite";
import type { SourceWriter } from "@pstdio/pocketcoder-contracts";
import { publicationIdentity } from "../checkpoints/archive-publication";
import { syncDirectory, syncSeed } from "../database/data-folder";
import type { RecoveryState } from "../recovery/state";
import { scanArchive } from "./archive-reader";
import type { BackupManifest } from "./manifest";
import { openRawDatabase } from "./raw-database";
import { verifyBackup } from "./verify-backup";

export interface RestoreOptions {
  archive: string;
  dataDir: string;
  checkpointDir?: string;
}

function emptyFolder(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (readdirSync(path).length) throw new Error(`Restore checkpoint folder must be empty: ${path}`);
  return realpathSync(path);
}

// The restored folder writes as itself, and its archives are new files with new identities.
async function rebaseDatabase(client: PGlite, writer: SourceWriter, recovery: RecoveryState, checkpointDir?: string) {
  await client.query(`UPDATE "pocketcoder"."checkpoint_controller_state" SET source_writer = $1, recovery = $2`, [
    writer,
    recovery,
  ]);
  const { rows } = await client.query<{ id: string; stage_path: string }>(
    `SELECT id, stage_path FROM "pocketcoder"."checkpoint_transfers" WHERE stage_path IS NOT NULL`,
  );
  for (const row of rows) {
    const file = openSync(join(checkpointDir as string, row.stage_path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const identity = publicationIdentity(fstatSync(file, { bigint: true }));
      await client.query(`UPDATE "pocketcoder"."checkpoint_transfers" SET stage_identity = $1 WHERE id = $2`, [
        identity,
        row.id,
      ]);
    } finally {
      closeSync(file);
    }
  }
  await client.query("CHECKPOINT");
}

async function extract(archive: string, stage: string, manifest: BackupManifest, checkpointDir?: string) {
  const file = openSync(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { members } = await scanArchive(file, fstatSync(file).size, (path) => {
      if (path.startsWith("checkpoints/")) return join(checkpointDir as string, basename(path));
      return path === "checkpoints" ? undefined : join(stage, path);
    });
    // The file was verified before extraction; it must not have changed since.
    if (!isDeepStrictEqual(members, manifest.members)) throw new Error("Backup archive changed during restore.");
  } finally {
    closeSync(file);
  }
}

// Restores a verified backup into a new data folder that starts in recovery mode.
export async function restoreBackup(options: RestoreOptions) {
  const { manifest } = await verifyBackup(options.archive);
  const requested = resolve(options.dataDir);
  const parent = realpathSync(dirname(requested));
  const target = join(parent, basename(requested));
  if (existsSync(target)) throw new Error(`Restore target already exists: ${target}`);
  if (manifest.checkpoints.length && !options.checkpointDir)
    throw new Error("This backup holds checkpoint archives; choose an empty checkpoint folder.");
  if (options.checkpointDir && `${resolve(options.checkpointDir)}/`.startsWith(`${requested}/`))
    throw new Error("Restore checkpoint folder must be outside the new data folder.");
  const checkpointDir = options.checkpointDir ? emptyFolder(options.checkpointDir) : undefined;
  let published = false;
  const stage = join(parent, `.${basename(target)}.restore-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    closeSync(openSync(join(stage, "LOCK"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600));
    await extract(options.archive, stage, manifest, checkpointDir);
    const root = lstatSync(stage, { bigint: true });
    const lock = lstatSync(join(stage, "LOCK"), { bigint: true });
    // Rename keeps both inodes, so this is the identity the folder has once published.
    const writer: SourceWriter = {
      format: "pocketcoder-source-writer/v1",
      directory: target,
      root: { device: root.dev.toString(), inode: root.ino.toString() },
      lock: { device: lock.dev.toString(), inode: lock.ino.toString() },
    };
    const recovery: RecoveryState = {
      format: "pocketcoder-recovery/v1",
      recoveryId: randomUUID(),
      snapshotId: manifest.snapshotId,
      journal: manifest.journal,
      createdAt: new Date().toISOString(),
    };
    const client = await openRawDatabase(join(stage, "db"));
    try {
      await rebaseDatabase(client, writer, recovery, checkpointDir);
    } finally {
      await client.close();
    }
    await syncSeed(stage);
    if (checkpointDir) syncDirectory(checkpointDir);
    renameSync(stage, target);
    published = true;
    syncDirectory(parent);
    return { directory: target, recovery, checkpoints: manifest.checkpoints.length };
  } catch (error) {
    // Once published, the restored folder owns its checkpoint files.
    if (!published) {
      rmSync(stage, { recursive: true, force: true });
      for (const name of checkpointDir ? readdirSync(checkpointDir) : []) rmSync(join(checkpointDir as string, name));
    }
    throw error;
  }
}
