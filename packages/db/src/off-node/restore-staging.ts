import { link, lstat, mkdir, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BackupManifest } from "../backup/manifest";
import { syncDirectory } from "../database/data-folder";
import { digestFile } from "./backup-receipt";

async function present(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function target(path: string) {
  return join(await realpath(dirname(resolve(path))), basename(path));
}

export async function restoreStaging(dataDir: string, checkpointDir: string, operationId: string) {
  const data = await target(dataDir);
  const checkpoints = await target(checkpointDir);
  if (checkpoints === data || checkpoints.startsWith(`${data}/`))
    throw new Error("Restore checkpoint folder must be outside the new data folder.");
  return {
    data,
    checkpoints,
    dataStage: join(dirname(data), `.${basename(data)}.restore-${operationId}`),
    checkpointStage: join(dirname(checkpoints), `.${basename(checkpoints)}.restore-${operationId}`),
  };
}
type Staging = Awaited<ReturnType<typeof restoreStaging>>;

export async function requireNewRestoreStages(staging: Staging) {
  if ((await present(staging.dataStage)) || (await present(staging.checkpointStage)))
    throw new Error("Restore staging path already exists.");
  const folder = await present(staging.checkpoints);
  if (folder && (!folder.isDirectory() || (await readdir(staging.checkpoints)).length))
    throw new Error("Restore checkpoint folder must be empty.");
}

// Only a matching durable restore intent may enter here. Caller checkpoint folders are never removed.
export async function removeRestoreStages(staging: Staging) {
  await rm(staging.dataStage, { recursive: true, force: true });
  await rm(staging.checkpointStage, { recursive: true, force: true });
}

export async function publishRestoreCheckpoints(staging: Staging, manifest: BackupManifest) {
  await mkdir(staging.checkpoints, { recursive: true, mode: 0o700 });
  const expected = manifest.checkpoints.map((checkpoint) => ({ ...checkpoint, name: basename(checkpoint.path) }));
  for (const name of await readdir(staging.checkpoints))
    if (!expected.some((checkpoint) => checkpoint.name === name))
      throw new Error("Restore checkpoint folder contains an unrelated file.");
  for (const checkpoint of expected) await publishCheckpoint(staging, checkpoint);
  syncDirectory(staging.checkpoints);
  await rm(staging.checkpointStage, { recursive: true, force: true });
  syncDirectory(dirname(staging.checkpointStage));
}

async function publishCheckpoint(staging: Staging, checkpoint: BackupManifest["checkpoints"][number]) {
  const name = basename(checkpoint.path);
  const source = join(staging.checkpointStage, name);
  const output = join(staging.checkpoints, name);
  const held = await present(source);
  let published = await present(output);
  if (held && !held.isFile()) throw new Error("Restored checkpoint stage is not a regular file.");
  if (!published) {
    if (!held) throw new Error("Restored checkpoint is missing.");
    // link() cannot replace a caller's file and keeps the inode recorded by the restored database.
    await link(source, output);
    syncDirectory(staging.checkpoints);
    published = await lstat(output);
  }
  if (!published.isFile() || (held && (held.dev !== published.dev || held.ino !== published.ino)))
    throw new Error("Restored checkpoint publication identity differs.");
  const actual = await digestFile(output);
  if (actual.bytes !== checkpoint.bytes || actual.digest !== checkpoint.digest)
    throw new Error("Restored checkpoint publication digest differs.");
  if (held) {
    await unlink(source);
    syncDirectory(staging.checkpointStage);
  }
}
