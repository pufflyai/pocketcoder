import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SourceWriter } from "@pstdio/pocketcoder-contracts";
import type { CheckpointStageIdentity } from "@pstdio/pocketcoder-runtime-contracts";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { DatabaseBudget } from "../backup/bounded-filesystem";
import type { BackupManifest } from "../backup/manifest";
import { openRawDatabase } from "../backup/raw-database";
import { publicationIdentity } from "../checkpoints/archive-publication";
import { destinationOpen, destinationStat } from "../checkpoints/destination-native";
import { lockDataFolder, syncSeed } from "../database/data-folder";
import { openDataDirectory } from "../database/directory-identity";
import { RecoveryStateSchema } from "../recovery/state";
import { createSchema } from "../schema";

function holdPublication(
  folder: ReturnType<typeof openDataDirectory>,
  checkpoint: BackupManifest["checkpoints"][number],
  expected: CheckpointStageIdentity,
) {
  const name = basename(checkpoint.path);
  const file = destinationOpen(folder.descriptor, name, constants.O_RDONLY);
  try {
    const stat = fstatSync(file, { bigint: true });
    const identity = publicationIdentity(stat);
    // Publishing the known hard link changes ctime, while custody and every other field stay the same.
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      Object.keys(expected).some(
        (key) =>
          key !== "ctimeNs" &&
          identity[key as keyof CheckpointStageIdentity] !== expected[key as keyof CheckpointStageIdentity],
      )
    )
      throw new Error("Restored checkpoint publication custody differs.");
    const validate = () => {
      folder.validate();
      const held = fstatSync(file, { bigint: true });
      const named = destinationStat(folder.descriptor, name);
      if (
        !held.isFile() ||
        held.nlink !== 1n ||
        !named.isFile() ||
        named.nlink !== 1n ||
        !isDeepStrictEqual(publicationIdentity(held), identity) ||
        !isDeepStrictEqual(publicationIdentity(named), identity)
      )
        throw new Error("Restored checkpoint publication changed during reconciliation.");
    };
    validate();
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(65_536);
    for (let offset = 0; offset < checkpoint.bytes; ) {
      validate();
      const bytes = readSync(file, chunk, 0, Math.min(chunk.length, checkpoint.bytes - offset), offset);
      if (!bytes) throw new Error("Restored checkpoint publication ended early.");
      hash.update(chunk.subarray(0, bytes));
      offset += bytes;
    }
    validate();
    if (identity.size !== String(checkpoint.bytes) || `sha256:${hash.digest("hex")}` !== checkpoint.digest)
      throw new Error("Restored checkpoint publication digest differs.");
    return { identity, validate, close: () => closeSync(file) };
  } catch (error) {
    closeSync(file);
    throw error;
  }
}

// Only the matching private restore intent reaches this boundary, before a controller can open recovery.
export async function reconcileRestoredPublications(
  dataDir: string,
  checkpointDir: string,
  manifest: BackupManifest,
  writer: SourceWriter,
  budget: DatabaseBudget,
) {
  const lock = lockDataFolder(dataDir);
  let folder: ReturnType<typeof openDataDirectory> | undefined;
  let client: Awaited<ReturnType<typeof openRawDatabase>> | undefined;
  const publications: ReturnType<typeof holdPublication>[] = [];
  try {
    if (!isDeepStrictEqual(lock.sourceWriter(), writer)) throw new Error("Restore physical writer differs.");
    folder = openDataDirectory(checkpointDir);
    client = await openRawDatabase(join(dataDir, "db"), budget);
    const db = drizzle({ client });
    const { controllerState, checkpointTransfers } = createSchema("pocketcoder");
    await db.transaction(async (tx) => {
      const [controller] = await tx.select().from(controllerState).where(eq(controllerState.id, "controller"));
      if (
        !isDeepStrictEqual(controller?.sourceWriter, lock.sourceWriter()) ||
        RecoveryStateSchema.parse(controller?.recovery).snapshotId !== manifest.snapshotId
      )
        throw new Error("Restore checkpoint snapshot or writer differs.");
      for (const checkpoint of manifest.checkpoints) {
        const [row] = await tx
          .select()
          .from(checkpointTransfers)
          .where(eq(checkpointTransfers.id, checkpoint.transferId));
        if (
          !row?.stageIdentity ||
          row.stagePath !== basename(checkpoint.path) ||
          row.checkpointId !== checkpoint.checkpointId ||
          row.direction !== "upload" ||
          row.state !== "complete" ||
          row.archiveDigest !== checkpoint.digest ||
          row.storedBytes !== checkpoint.bytes
        )
          throw new Error("Restore checkpoint receipt differs.");
        const publication = holdPublication(
          folder as ReturnType<typeof openDataDirectory>,
          checkpoint,
          row.stageIdentity,
        );
        publications.push(publication);
        await tx
          .update(checkpointTransfers)
          .set({ stageIdentity: publication.identity })
          .where(eq(checkpointTransfers.id, row.id));
        publication.validate();
      }
      lock.validate();
      for (const publication of publications) publication.validate();
    });
    await client.query("CHECKPOINT");
    for (const publication of publications) publication.validate();
    await client.close();
    client = undefined;
    await syncSeed(dataDir);
    lock.validate();
    for (const publication of publications) publication.validate();
  } finally {
    for (const publication of publications) publication.close();
    try {
      await client?.close();
    } finally {
      try {
        folder?.close();
      } finally {
        lock.close();
      }
    }
  }
}
