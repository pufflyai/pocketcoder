import { randomUUID } from "node:crypto";
import seed from "../../assets/core-seed.json" with { type: "json" };
import type { DatabaseContext } from "../database/context";
import { createArchiveOutput } from "./archive-output";
import { captureDatabase } from "./database-snapshot";
import { BACKUP_FORMAT, type BackupKeys, type BackupManifest, KEY_NAMES, MANIFEST_PATH } from "./manifest";

export interface BackupOptions {
  output: string;
  checkpointDirectory?: string;
  keys: BackupKeys;
  signal: AbortSignal;
  // Runs the database capture inside the caller's maintenance window, which may end it early.
  freeze<T>(capture: (check: () => void) => Promise<T>): Promise<T>;
}

async function* bytesOf(value: Uint8Array) {
  yield value;
}

export async function writeBackup(context: DatabaseContext, options: BackupOptions) {
  const check = () => options.signal.throwIfAborted();
  if (!context.dataDir) throw new Error("Backup requires a data folder on disk.");
  const excluded = [context.dataDir, ...(options.checkpointDirectory ? [options.checkpointDirectory] : [])];
  const archive = createArchiveOutput(options.output, excluded, check);
  const createdAt = new Date().toISOString();
  let snapshot: Awaited<ReturnType<typeof captureDatabase>> | undefined;
  try {
    snapshot = await options.freeze((windowCheck) =>
      captureDatabase(context, archive, options.checkpointDirectory, () => {
        check();
        windowCheck();
      }),
    );
    await archive.directory("keys");
    for (const name of KEY_NAMES) await archive.file(`keys/${name}`, 32, bytesOf(options.keys[name]));
    await archive.directory("checkpoints");
    const checkpoints: BackupManifest["checkpoints"] = [];
    for (const publication of snapshot.publications) {
      const path = `checkpoints/${publication.name}`;
      await archive.file(path, publication.file.size, publication.file.chunks(check));
      const copied = archive.members.at(-1);
      if (copied?.type !== "file" || copied.digest !== publication.digest || copied.bytes !== publication.bytes)
        throw new Error(`Checkpoint archive differs from its receipt: ${publication.name}`);
      checkpoints.push({
        checkpointId: publication.checkpointId,
        transferId: publication.transferId,
        path,
        bytes: copied.bytes,
        digest: copied.digest,
      });
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      snapshotId: randomUUID(),
      createdAt,
      engine: { pglite: seed.pgliteVersion, postgres: seed.postgresVersion },
      database: { position: snapshot.position, migrations: snapshot.migrations },
      checkpoints,
      members: [...archive.members],
    };
    const text = Buffer.from(JSON.stringify(manifest));
    await archive.file(MANIFEST_PATH, text.length, bytesOf(text));
    const published = await archive.publish();
    return {
      ...published,
      snapshotId: manifest.snapshotId,
      position: snapshot.position,
      checkpoints: checkpoints.length,
    };
  } catch (error) {
    archive.discard();
    throw error;
  } finally {
    for (const publication of snapshot?.publications ?? []) publication.file.close();
  }
}
