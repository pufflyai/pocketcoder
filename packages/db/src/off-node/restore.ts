import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import type { DatabaseBudget } from "../backup/bounded-filesystem";
import { restoreBackup } from "../backup/restore-backup";
import { inspectBackup, verifyBackup } from "../backup/verify-backup";
import type { JournalSnapshot } from "../journal/acknowledgement";
import { JOURNAL_FORMAT, type JournalCursorSchema } from "../journal/events";
import { sourceWriterIdentity } from "../recovery/source-writer";
import { RecoveryStateSchema } from "../recovery/state";
import { PGliteStore } from "../store";
import { digestFile, type OffNodeBackupReceipt } from "./backup-receipt";
import type { OffNode } from "./config";
import { downloadFile } from "./download";
import { decryptFile } from "./encryption";
import { readPrivateFile, requirePrivateJsonCapacity, writePrivateJson } from "./private-files";
import { restoreCapacity } from "./restore-capacity";
import {
  publishRestoreCheckpoints,
  removeRestoreStages,
  requireNewRestoreStages,
  restoreStaging,
} from "./restore-staging";
import { reconcileRestoredPublications } from "./restored-publications";
import { manifestFootprint, type StagingPolicy } from "./staging-capacity";

const Result = z.strictObject({
  directory: z.string(),
  recovery: RecoveryStateSchema,
  checkpoints: z.number(),
  writer: SourceWriterSchema,
});
export interface OffNodeRestoreInput {
  operationId: string;
  receipt: OffNodeBackupReceipt;
  offNode: OffNode;
  dataDir: string;
  checkpointDir: string;
  journalDir: string;
  staging?: StagingPolicy;
}

function covers(snapshot: JournalSnapshot, cursor: z.infer<typeof JournalCursorSchema>) {
  const header = JSON.stringify({ format: JOURNAL_FORMAT, journalId: snapshot.head.journalId });
  const digest =
    cursor.sequence === 0
      ? createHash("sha256").update(header).digest("hex")
      : snapshot.records[cursor.sequence - 1]?.digest;
  if (snapshot.head.journalId !== cursor.journalId || digest !== cursor.digest)
    throw new Error("Current off-node journal does not cover this backup. Recovery stays closed.");
}

async function installJournal(directory: string, snapshot: JournalSnapshot) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(directory, "journal.log"), "w", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(
      `${JSON.stringify({ format: JOURNAL_FORMAT, journalId: snapshot.head.journalId })}\n${snapshot.records.map((record) => `${JSON.stringify(record)}\n`).join("")}`,
    );
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function published(input: OffNodeRestoreInput, snapshotId: string, databaseBudget: DatabaseBudget) {
  const store = await PGliteStore.create(input.dataDir, { journalDir: input.journalDir, databaseBudget });
  try {
    const recovery = await store.recovery.recoveryState();
    if (!recovery || recovery.snapshotId !== snapshotId)
      throw new Error("Restore target belongs to another operation.");
    const source = await store.storageReservations.get(input.receipt.staging.reservationId);
    if (source?.purpose !== "backup" || source.operationId || source.workspaceId || source.principalId)
      throw new Error("Backup source staging reservation differs.");
    if (sourceWriterIdentity(store.journalSnapshot().writer) === sourceWriterIdentity(input.receipt.sourceWriter))
      throw new Error("Backup source staging cannot be retired on its original volume.");
    // The verified archive only contains db, keys and retained checkpoints; its source scratch was not copied.
    if (source.state !== "released") {
      await store.storageReservations.beginRelease(source.id, () => {});
      await store.storageReservations.release(source.id, () => {
        if (sourceWriterIdentity(store.journalSnapshot().writer) === sourceWriterIdentity(input.receipt.sourceWriter))
          throw new Error("Restore source writer identity differs.");
      });
    }
    return { recovery, writer: store.journalSnapshot().writer };
  } finally {
    await store.close();
  }
}

function assertFootprint(inspected: Awaited<ReturnType<typeof inspectBackup>>, receipt: OffNodeBackupReceipt) {
  if (
    inspected.manifest.stagingReservationId !== receipt.staging.reservationId ||
    inspected.bytes !== receipt.staging.archiveBytes ||
    !isDeepStrictEqual(manifestFootprint(inspected.manifest), receipt.staging.contents) ||
    !isDeepStrictEqual(manifestFootprint(inspected.manifest, true), receipt.staging.database)
  )
    throw new Error("Backup staging footprint differs from its receipt.");
}

async function bindRestoreIntent(
  path: string,
  intent: unknown,
  input: OffNodeRestoreInput,
  staging: Awaited<ReturnType<typeof restoreStaging>>,
) {
  requirePrivateJsonCapacity(intent, 65_536);
  try {
    if (!isDeepStrictEqual(JSON.parse((await readPrivateFile(path, 65_536)).toString()), intent))
      throw new Error("Restore operation identity differs.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (await Bun.file(join(input.dataDir, "LOCK")).exists()) throw new Error("Restore target already exists.");
    await requireNewRestoreStages(staging);
    await writePrivateJson(path, intent, 65_536);
  }
}

// The caller must stop and prove zero source compute before entering this operation.
// This publishes recovery-only data; writer transfer and admission are separate manager phases.
export async function restoreOffNodeBackup(input: OffNodeRestoreInput) {
  const { receipt, offNode } = input;
  z.uuid().parse(input.operationId);
  if (receipt.accountId !== offNode.config.accountId) throw new Error("Backup belongs to another account.");
  requirePrivateJsonCapacity(
    { operationId: input.operationId, snapshotId: receipt.snapshotId, sourceWriter: receipt.sourceWriter, receipt },
    65_536,
  );
  const staging = await restoreStaging(input.dataDir, input.checkpointDir, input.operationId);
  const directory = join(offNode.directory, "restores", input.operationId);
  const intent = {
    receipt,
    dataDir: staging.data,
    journalDir: resolve(input.journalDir),
    checkpointDir: staging.checkpoints,
  };
  const intentPath = join(directory, "intent.json");
  await bindRestoreIntent(intentPath, intent, input, staging);
  const resultPath = join(directory, "result.json");
  const encrypted = join(directory, "backup.enc");
  const archive = join(directory, "backup.tar");
  const verification = join(directory, "verify");
  const scratch = [encrypted, archive, verification, staging.dataStage, staging.checkpointStage];
  const capacity = await restoreCapacity({
    directory,
    root: offNode.directory,
    identity: intent,
    receipt,
    staging: input.staging ?? offNode.config.staging,
    paths: [...scratch, input.dataDir, input.checkpointDir, input.journalDir],
    targets: [input.dataDir, input.checkpointDir, input.journalDir],
    journalBytes: 0,
  });
  try {
    try {
      const result = Result.parse(JSON.parse((await readPrivateFile(resultPath, 65_536)).toString()));
      // Opening validates the real LOCK identity and the bound journal, even after completion.
      const store = await PGliteStore.create(input.dataDir, {
        journalDir: input.journalDir,
        databaseBudget: capacity.databaseBudget,
      });
      try {
        if (sourceWriterIdentity(store.journalSnapshot().writer) !== sourceWriterIdentity(result.writer))
          throw new Error("Restore volume identity differs.");
      } finally {
        await store.close();
      }
      await removeRestoreStages(staging);
      await rm(verification, { recursive: true, force: true });
      await rm(join(directory, "backup.enc"), { force: true });
      await rm(join(directory, "backup.tar"), { force: true });
      await capacity.release(scratch);
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const current = await offNode.journal.current();
    if (!current) throw new Error("Current off-node journal is missing.");
    requirePrivateJsonCapacity(
      { operationId: input.operationId, snapshotId: receipt.snapshotId, sourceWriter: current.writer, receipt },
      65_536,
    );
    covers(current, receipt.journal);
    await capacity.admit(Buffer.byteLength(JSON.stringify(current)));
    await rm(verification, { recursive: true, force: true });
    await rm(encrypted, { force: true });
    await rm(archive, { force: true });
    await capacity.materialize();
    await downloadFile(
      await offNode.storage.get(receipt.object.key, receipt.object.versionId),
      encrypted,
      receipt.object.bytes,
    );
    await capacity.materialize();
    const ciphertext = await digestFile(encrypted);
    if (ciphertext.digest !== receipt.object.digest || ciphertext.bytes !== receipt.object.bytes)
      throw new Error("Off-node backup digest differs.");
    await decryptFile(encrypted, archive, offNode.encryptionKey, receipt.object.key);
    if ((await digestFile(archive)).digest !== receipt.plaintextDigest)
      throw new Error("Plaintext backup digest differs.");
    await capacity.materialize();
    const inspected = await inspectBackup(archive);
    assertFootprint(inspected, receipt);
    const { manifest, runtimes } = await verifyBackup(archive, capacity.verification);
    if (!isDeepStrictEqual(runtimes, receipt.runtimes))
      throw new Error("Backup runtime identities differ from its receipt.");
    if (manifest.snapshotId !== receipt.snapshotId || !isDeepStrictEqual(manifest.journal, receipt.journal))
      throw new Error("Backup manifest differs from its receipt.");
    if (!(await Bun.file(join(input.dataDir, "LOCK")).exists())) {
      await removeRestoreStages(staging);
      await installJournal(input.journalDir, current);
      await restoreBackup({
        archive,
        dataDir: input.dataDir,
        checkpointDir: staging.checkpointStage,
        stagingId: input.operationId,
        verification: capacity.verification,
      });
    }
    await capacity.materialize();
    const recovered = await published(input, receipt.snapshotId, capacity.databaseBudget);
    await publishRestoreCheckpoints(staging, manifest);
    await reconcileRestoredPublications(
      staging.data,
      staging.checkpoints,
      manifest,
      recovered.writer,
      capacity.databaseBudget,
    );
    await writePrivateJson(
      join(input.dataDir, "off-node-restore.json"),
      {
        operationId: input.operationId,
        snapshotId: receipt.snapshotId,
        sourceWriter: current.writer,
        receipt,
      },
      65_536,
    );
    await writePrivateJson(join(input.dataDir, "account-lifecycle.json"), {
      state: "suspended",
      current: null,
      completed: [],
    });
    const result = Result.parse({
      directory: resolve(input.dataDir),
      recovery: recovered.recovery,
      checkpoints: manifest.checkpoints.length,
      writer: recovered.writer,
    });
    await writePrivateJson(resultPath, result, 65_536);
    await rm(encrypted);
    await rm(archive);
    await capacity.release(scratch);
    return result;
  } finally {
    capacity.close();
  }
}
