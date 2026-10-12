import { existsSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { lockDataFolder, syncDirectory, syncSeed } from "@pstdio/pocketcoder-db/engine";
import {
  allocated,
  checkStagingCapacity,
  readPrivateFile,
  stagingDisk,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { managerContext } from "../database/context";
import { purgeErasure } from "../database/purge-erasure";
import { createPurgeAuthority, type PurgeAuthority } from "../purge/authority";
import { readManagerArchive } from "./archive";
import { verifyEncryptedBackup } from "./capture";
import { type ManagerReceipt, ManagerReceiptSchema } from "./manifest";
import { type ManagerBackupOptions, managerEncryptionKey, managerStaging } from "./staging";
import { InstallationSchema, installationPath, recoveryReceiptDigest, transferManagerWriter } from "./writer";

const RequestSchema = z.strictObject({ operationId: z.uuid(), receipt: ManagerReceiptSchema });
const RecoverySchema = RequestSchema.extend({ phase: z.enum(["restoring", "replaying"]) });
const markerPath = (directory: string) => join(directory, "RECOVERY.json");
export type ManagerRestoreOptions = ManagerBackupOptions & { receipt: ManagerReceipt };
async function repairFormat(directory: string) {
  const file = await open(join(directory, "FORMAT"), "wx", 0o600);
  try {
    await file.writeFile("pocketcoder-manager/v1\n");
    await file.sync();
  } finally {
    await file.close();
  }
  syncDirectory(directory);
}
async function requireJournal(options: ManagerRestoreOptions) {
  const identity = join(options.purge.directory, "manager-journal", "identity.json");
  if (!existsSync(identity)) throw new Error("Independent manager journal evidence is missing; recovery stays closed.");
  const authority = await createPurgeAuthority(options.dataDir, options.purge);
  try {
    authority.journal.require(options.receipt.journal);
    return authority;
  } catch (error) {
    authority.close();
    throw error;
  }
}
function request(input: ManagerRestoreOptions) {
  return { ...input, ...RequestSchema.parse({ operationId: input.operationId, receipt: input.receipt }) };
}
async function completed(options: ManagerRestoreOptions) {
  if (!existsSync(installationPath(options.dataDir)) || existsSync(markerPath(options.dataDir))) return false;
  const installation = InstallationSchema.parse(
    JSON.parse((await readPrivateFile(installationPath(options.dataDir), 65_536)).toString()),
  );
  if (
    installation.recoveryOperationId !== options.operationId ||
    installation.recoveryReceiptDigest !== recoveryReceiptDigest(options.receipt)
  )
    throw new Error("Manager recovery operation identity differs.");
  return true;
}
export async function restoreManagerBackup(input: ManagerRestoreOptions) {
  const options = request(input);
  const key = await managerEncryptionKey(options);
  const folder = lockDataFolder(options.dataDir);
  let authority: PurgeAuthority | undefined;
  let stage: Awaited<ReturnType<typeof managerStaging>> | undefined;
  try {
    authority = await requireJournal(options);
    if (await completed(options)) return;
    const extract = join(folder.dir, `.restore-${options.operationId}`);
    if (existsSync(markerPath(folder.dir))) {
      const prior = RecoverySchema.parse(
        JSON.parse((await readPrivateFile(markerPath(folder.dir), 16 * 1024 ** 2)).toString()),
      );
      if (
        !isDeepStrictEqual(
          { operationId: prior.operationId, receipt: prior.receipt },
          { operationId: options.operationId, receipt: options.receipt },
        )
      )
        throw new Error("Manager recovery request differs.");
      if (existsSync(join(folder.dir, "db"))) {
        if (!existsSync(join(folder.dir, "FORMAT"))) {
          await repairFormat(folder.dir);
        }
        await rm(extract, { recursive: true, force: true });
        await writePrivateJson(markerPath(folder.dir), { ...prior, phase: "replaying" }, 16 * 1024 ** 2);
        return;
      }
    } else {
      if (existsSync(join(folder.dir, "db")) || existsSync(join(folder.dir, "FORMAT")))
        throw new Error("Manager restore requires a fresh data folder.");
      await writePrivateJson(
        markerPath(folder.dir),
        { operationId: options.operationId, receipt: options.receipt, phase: "restoring" },
        16 * 1024 ** 2,
      );
    }
    folder.validate();
    await rm(extract, { recursive: true, force: true });
    stage = await managerStaging(options);
    const targetDisk = await stagingDisk(folder.dir, options.staging);
    const amount = allocated(options.receipt.footprint, targetDisk.block);
    const archives = { bytes: options.receipt.object.bytes + options.receipt.plaintext.bytes, files: 32 };
    const database = { bytes: amount.bytes + 64 * 1024 ** 2, files: amount.files + 32 };
    stage.policy({ bytes: archives.bytes + database.bytes, files: archives.files + database.files });
    const verified = await verifyEncryptedBackup(authority, options.receipt, key, stage);
    checkStagingCapacity(database, await stagingDisk(folder.dir, options.staging));
    folder.validate();
    await mkdir(extract, { mode: 0o700 });
    await readManagerArchive(verified.path, extract);
    await writeFile(join(extract, "FORMAT"), "pocketcoder-manager/v1\n", { mode: 0o600, flag: "wx" });
    const context = await managerContext(extract);
    try {
      const accounts = await context.db.select().from(context.tables.accounts);
      const operations = await context.db.select().from(context.tables.operations);
      const inventory = accounts.map((account) => ({
        id: account.id,
        namespace: account.namespace,
        state: account.state,
        operations: operations
          .filter((operation) => operation.accountId === account.id)
          .map((operation) => operation.id),
      }));
      if (!isDeepStrictEqual(inventory, verified.manifest.inventory))
        throw new Error("Manager backup database inventory differs.");
    } finally {
      await context.close();
    }
    folder.validate();
    await syncSeed(extract);
    await rename(join(extract, "FORMAT"), join(folder.dir, "FORMAT"));
    syncDirectory(folder.dir);
    await rename(join(extract, "db"), join(folder.dir, "db"));
    syncDirectory(folder.dir);
    await writePrivateJson(
      markerPath(folder.dir),
      { operationId: options.operationId, receipt: options.receipt, phase: "replaying" },
      16 * 1024 ** 2,
    );
    await rm(extract, { recursive: true });
    await stage.reset();
  } finally {
    stage?.close();
    authority?.close();
    folder.close();
  }
}
export async function completeManagerRecovery(input: ManagerRestoreOptions) {
  const options = request(input);
  if (!existsSync(join(options.dataDir, "db")) || !existsSync(join(options.dataDir, "FORMAT")))
    throw new Error("Manager restore is incomplete; run restore before recovery.");
  if (existsSync(markerPath(options.dataDir))) {
    const pending = RecoverySchema.parse(
      JSON.parse((await readPrivateFile(markerPath(options.dataDir), 16 * 1024 ** 2)).toString()),
    );
    if (pending.phase !== "replaying") throw new Error("Manager restore is incomplete; run restore before recovery.");
  }
  const context = await managerContext(options.dataDir);
  let authority: PurgeAuthority | undefined;
  try {
    authority = await requireJournal(options);
    if (await completed(options)) return;
    const pending = RecoverySchema.parse(
      JSON.parse((await readPrivateFile(markerPath(options.dataDir), 16 * 1024 ** 2)).toString()),
    );
    if (
      !isDeepStrictEqual(
        { operationId: pending.operationId, receipt: pending.receipt },
        { operationId: options.operationId, receipt: options.receipt },
      )
    )
      throw new Error("Manager recovery request differs.");
    await authority.refresh();
    const erase = purgeErasure(context);
    for (const intent of authority.intents()) await erase(intent);
    // Account controllers keep their original identities. Reconciliation later uses the saved operation IDs.
    await transferManagerWriter(context, authority, options.operationId, options.receipt);
    await rm(markerPath(options.dataDir));
    syncDirectory(options.dataDir);
  } finally {
    authority?.close();
    await context.close();
  }
}
