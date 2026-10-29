import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  decryptFile,
  digestFile,
  downloadFile,
  encryptFile,
  readPrivateFile,
  sourceFootprint,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { managerContext } from "../database/context";
import { createPurgeAuthority, type PurgeAuthority } from "../purge/authority";
import { readManagerArchive, writeManagerArchive } from "./archive";
import { ManagerReceiptSchema } from "./manifest";
import { requireExistingSource } from "./source-transfer";
import { type ManagerBackupOptions, managerEncryptionKey, managerStaging } from "./staging";
import { assertManagerInstallation, bindManagerWriter } from "./writer";

export async function captureManagerBackup(input: ManagerBackupOptions) {
  const options = { ...input, operationId: z.uuid().parse(input.operationId) };
  const key = await managerEncryptionKey(options);
  if (options.purge.source?.migrationFile) requireExistingSource(options.dataDir);
  const context = await managerContext(options.dataDir);
  let authority: PurgeAuthority | undefined;
  let stage: Awaited<ReturnType<typeof managerStaging>> | undefined;
  try {
    authority = await createPurgeAuthority(options.dataDir, options.purge);
    await assertManagerInstallation(context, authority);
    await bindManagerWriter(context, authority);
    stage = await managerStaging(options);
    const receiptFile = join(stage.directory, "receipt.json");
    if (existsSync(receiptFile)) {
      const receipt = ManagerReceiptSchema.parse(
        JSON.parse((await readPrivateFile(receiptFile, 16 * 1024 ** 2)).toString()),
      );
      if (
        !isDeepStrictEqual(receipt.sourceWriter, context.sourceWriter()) ||
        receipt.operationId !== options.operationId
      )
        throw new Error("Manager backup request identity differs.");
      authority.journal.require(receipt.journal);
      await verifyEncryptedBackup(authority, receipt, key, stage);
      return receipt;
    }
    const objectKey = `manager/backups/${authority.journal.head().journalId}/${options.operationId}/archive.enc`;
    // A retry owns only this backup prefix. It removes uncertain uploads before making another snapshot.
    await authority.storage.clean(objectKey);
    await stage.reset();
    const footprint = await sourceFootprint(join(options.dataDir, "db"));
    await stage.admit({
      bytes: footprint.bytes * 3 + footprint.files * 8192 + 64 * 1024 ** 2,
      files: footprint.files + footprint.directories + 32,
    });
    await authority.refresh();
    const archive = await writeManagerArchive(
      context,
      authority.journal.head(),
      join(stage.directory, "plain.tar"),
      Math.floor((await stage.maximum()) / 3),
      options.operationId,
    );
    await readManagerArchive(archive.path);
    const encrypted = join(stage.directory, "encrypted");
    await encryptFile(archive.path, encrypted, key, objectKey);
    const object = await authority.storage.uploadFile(objectKey, encrypted);
    const receipt = ManagerReceiptSchema.parse({
      format: "pocketcoder-manager-receipt/v1",
      operationId: options.operationId,
      createdAt: archive.manifest.createdAt,
      journal: archive.manifest.journal,
      sourceWriter: archive.manifest.sourceWriter,
      plaintext: { bytes: archive.bytes, digest: archive.digest },
      footprint,
      object,
    });
    await verifyEncryptedBackup(authority, receipt, key, stage);
    await authority.refresh();
    authority.journal.require(receipt.journal);
    await writePrivateJson(receiptFile, receipt, 16 * 1024 ** 2);
    await stage.reset();
    return receipt;
  } finally {
    stage?.close();
    authority?.close();
    await context.close();
  }
}
export async function verifyEncryptedBackup(
  authority: PurgeAuthority,
  receipt: ReturnType<typeof ManagerReceiptSchema.parse>,
  key: Uint8Array,
  stage: Awaited<ReturnType<typeof managerStaging>>,
) {
  await stage.reset();
  const encrypted = join(stage.directory, "encrypted");
  const plain = join(stage.directory, "verified");
  const response = await authority.storage.get(receipt.object.key, receipt.object.versionId);
  if (response.headers.get("x-amz-version-id") !== receipt.object.versionId) {
    await response.body?.cancel();
    throw new Error("Manager backup object version differs.");
  }
  await stage.admit({ bytes: receipt.object.bytes + receipt.plaintext.bytes, files: 32 });
  await downloadFile(response, encrypted, receipt.object.bytes);
  if (!isDeepStrictEqual(await digestFile(encrypted), { bytes: receipt.object.bytes, digest: receipt.object.digest }))
    throw new Error("Encrypted manager backup checksum differs.");
  await decryptFile(encrypted, plain, key, receipt.object.key);
  if (!isDeepStrictEqual(await digestFile(plain), receipt.plaintext))
    throw new Error("Manager backup plaintext checksum differs.");
  const manifest = await readManagerArchive(plain);
  if (
    manifest.operationId !== receipt.operationId ||
    !isDeepStrictEqual(manifest.journal, receipt.journal) ||
    !isDeepStrictEqual(manifest.sourceWriter, receipt.sourceWriter)
  )
    throw new Error("Manager backup receipt differs from its archive.");
  const files = manifest.members.filter((member) => member.type === "file");
  const bytes = files.reduce((sum, member) => sum + member.bytes, 0);
  const directories = manifest.members.length - files.length;
  if (
    receipt.footprint.bytes < bytes ||
    receipt.footprint.files < files.length ||
    receipt.footprint.directories < directories
  )
    throw new Error("Manager backup receipt understates the archive footprint.");
  return { manifest, path: plain };
}
