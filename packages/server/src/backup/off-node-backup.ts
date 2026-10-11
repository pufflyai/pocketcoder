import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PGliteStore } from "@pstdio/pocketcoder-db";
import { inspectBackup, verifyBackup } from "@pstdio/pocketcoder-db/backup";
import {
  decryptFile,
  digestFile,
  digestResponse,
  encryptFile,
  type ObjectReceipt,
  type OffNode,
  type OffNodeBackupReceipt,
  OffNodeBackupReceiptSchema,
  PrivateFileLimitError,
  readPrivateFile,
  requirePrivateJsonCapacity,
  type StagingPolicy,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import type { ControllerBackup } from "./controller-backup";
import { admitCapture, releaseCapture } from "./off-node-capacity";
import { capturedRuntimeProof } from "./runtime-proof";

export function createOffNodeBackup(deps: {
  store: PGliteStore;
  offNode: OffNode;
  backup: ControllerBackup;
  staging?: StagingPolicy;
}) {
  const running = new Map<string, Promise<OffNodeBackupReceipt>>();
  const { offNode, store } = deps;
  async function boundedMetadata(
    receipt: OffNodeBackupReceipt,
    directory: string,
    reservationId: string,
    prefix: string,
  ) {
    try {
      requirePrivateJsonCapacity(
        {
          operationId: receipt.operationId,
          snapshotId: receipt.snapshotId,
          sourceWriter: receipt.sourceWriter,
          receipt,
        },
        65_536,
      );
    } catch (error) {
      if (error instanceof PrivateFileLimitError) {
        // Remote cleanup must finish before the durable intent and its staging ownership are retired.
        await offNode.storage.clean(prefix);
        await releaseCapture(store, directory, reservationId);
      }
      throw error;
    }
  }
  async function existingReceipt(receiptPath: string, operationId: string) {
    try {
      const receipt = OffNodeBackupReceiptSchema.parse(
        JSON.parse((await readPrivateFile(receiptPath, 65_536)).toString()),
      );
      if (receipt.accountId !== offNode.config.accountId || receipt.operationId !== operationId)
        throw new Error("Off-node backup operation identity differs.");
      if (!isDeepStrictEqual(receipt.sourceWriter, store.journalSnapshot().writer))
        throw new Error("Off-node backup source writer differs.");
      const remote = await digestResponse(await offNode.storage.get(receipt.object.key, receipt.object.versionId));
      if (remote.digest !== receipt.object.digest || remote.bytes !== receipt.object.bytes)
        throw new Error("Off-node backup differs from its receipt.");
      await store.acknowledgeJournal();
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  async function prepareCipher(archive: string, encrypted: string, key: string) {
    const plaintext = await digestFile(archive);
    if (await Bun.file(encrypted).exists()) {
      if ((await stat(encrypted)).size !== plaintext.bytes + 41) await rm(encrypted);
    }
    if (await Bun.file(encrypted).exists()) {
      const check = `${encrypted}.check`;
      await rm(check, { force: true });
      try {
        await decryptFile(encrypted, check, offNode.encryptionKey, key);
        if ((await digestFile(check)).digest !== plaintext.digest) throw new Error("Encrypted backup differs.");
      } catch {
        await rm(encrypted, { force: true });
      } finally {
        await rm(check, { force: true });
      }
    }
    if (!(await Bun.file(encrypted).exists())) await encryptFile(archive, encrypted, offNode.encryptionKey, key);
    return plaintext;
  }
  async function upload(encrypted: string, prefix: string, key: string) {
    const ciphertext = await digestFile(encrypted);
    const prior = (await offNode.storage.versions(prefix)).find(
      (item) => item.key === key && item.latest && !item.deleted,
    );
    if (prior) {
      const response = await offNode.storage.get(key, prior.versionId);
      const etag = response.headers.get("etag");
      const remote = await digestResponse(response);
      if (etag && remote.digest === ciphertext.digest && remote.bytes === ciphertext.bytes)
        return { key, versionId: prior.versionId, etag, ...ciphertext } satisfies ObjectReceipt;
    }
    await offNode.storage.clean(prefix);
    return offNode.storage.uploadFile(key, encrypted);
  }
  async function run(operationId: string, signal: AbortSignal) {
    z.uuid().parse(operationId);
    const directory = join(offNode.directory, "operations", operationId);
    const receiptPath = join(directory, "receipt.json");
    const archive = join(directory, "backup.tar");
    const encrypted = join(directory, "backup.enc");
    const partial = join(directory, ".backup.tar.partial");
    const existing = await existingReceipt(receiptPath, operationId);
    if (existing) {
      await releaseCapture(store, directory, existing.staging.reservationId);
      return existing;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const capacity = await admitCapture(deps, directory, operationId, () => signal.throwIfAborted());
    // The validated, serialized operation owns this unfinished capture; a new capture must not reuse it.
    await rm(partial, { force: true });
    await rm(capacity.verification.scratch, { recursive: true, force: true });
    await rm(`${encrypted}.check`, { force: true });
    await capacity.materialize();
    const prefix = `accounts/${offNode.config.accountId}/backups/${operationId}/`;
    const key = `${prefix}backup.enc`;
    if (!(await Bun.file(archive).exists())) {
      await store.acknowledgeJournal();
      await deps.backup(
        {
          output: archive,
          timeout_ms: 30_000,
          archiveLimit: capacity.intent.limit,
          stagingReservationId: capacity.intent.reservationId,
        },
        signal,
      );
    }
    const inspected = await inspectBackup(archive);
    if (inspected.manifest.stagingReservationId !== capacity.intent.reservationId)
      throw new Error("Backup staging generation differs.");
    if (inspected.bytes > capacity.intent.limit.bytes) throw new Error("Backup exceeds its admitted capacity.");
    const staging = { ...capacity.footprint(inspected.manifest), archiveBytes: inspected.bytes };
    await capacity.materialize();
    const { manifest, runtimes } = await verifyBackup(archive, capacity.verification);
    const metadata = {
      accountId: offNode.config.accountId,
      operationId,
      snapshotId: manifest.snapshotId,
      createdAt: manifest.createdAt,
      journal: manifest.journal,
      sourceWriter: store.journalSnapshot().writer,
      runtimes,
      staging,
    };
    // Digests have fixed width. Version and ETag remain unknown until the real upload completes.
    await boundedMetadata(
      OffNodeBackupReceiptSchema.parse({
        ...metadata,
        plaintextDigest: `sha256:${"0".repeat(64)}`,
        object: { key, versionId: "x", etag: "x", bytes: inspected.bytes + 41, digest: `sha256:${"0".repeat(64)}` },
      }),
      directory,
      capacity.intent.reservationId,
      prefix,
    );
    const plaintext = await prepareCipher(archive, encrypted, key);
    const object = await upload(encrypted, prefix, key);
    await capacity.materialize();
    await store.acknowledgeJournal();
    const receipt = OffNodeBackupReceiptSchema.parse({
      ...metadata,
      plaintextDigest: plaintext.digest,
      object,
    });
    await boundedMetadata(receipt, directory, capacity.intent.reservationId, prefix);
    await writePrivateJson(receiptPath, receipt, 65_536);
    await rm(archive);
    await rm(encrypted);
    await releaseCapture(store, directory, capacity.intent.reservationId);
    return receipt;
  }
  const capture = (operationId: string, signal: AbortSignal) => {
    const existing = running.get(operationId);
    if (existing) return existing;
    const operation = run(operationId, signal).finally(() => running.delete(operationId));
    running.set(operationId, operation);
    return operation;
  };
  return Object.assign(capture, {
    runtimeProof: (operationId: string) => capturedRuntimeProof(store, offNode, operationId),
  });
}
export type OffNodeBackup = ReturnType<typeof createOffNodeBackup>;
