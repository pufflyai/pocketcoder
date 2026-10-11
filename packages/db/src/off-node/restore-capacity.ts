import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { syncDirectory } from "../database/data-folder";
import { lockWriterDescriptor } from "../database/writer-lock";
import type { OffNodeBackupReceipt } from "./backup-receipt";
import { readPrivateFile, requirePrivateJsonCapacity, writePrivateJson } from "./private-files";
import {
  allocated,
  checkStagingCapacity,
  copies,
  DATABASE_WORK,
  materialized,
  type StagingPolicy,
  stagingDisk,
} from "./staging-capacity";

const amount = z.strictObject({
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  files: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const Record = z
  .strictObject({ generation: z.uuid(), identity: z.string(), amount, materialized: amount })
  .refine(
    (record) => record.materialized.bytes <= record.amount.bytes && record.materialized.files <= record.amount.files,
    "Restore materialization exceeds its reservation.",
  );

export async function restoreCapacity(input: {
  directory: string;
  root: string;
  identity: unknown;
  receipt: OffNodeBackupReceipt;
  staging: StagingPolicy;
  paths: string[];
  targets: string[];
  journalBytes: number;
}) {
  const descriptor = openSync(
    join(input.root, "restore-capacity.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    lockWriterDescriptor(descriptor, input.root);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  const path = join(input.directory, "capacity.json");
  const identity = JSON.stringify(input.identity);
  async function read(path: string) {
    try {
      return Record.parse(JSON.parse((await readPrivateFile(path, 65_536)).toString()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  try {
    const disk = await stagingDisk(input.root, input.staging);
    const device = (await lstat(input.root)).dev;
    for (const target of input.targets)
      if ((await lstat(dirname(target))).dev !== device)
        throw new Error("Off-node restore staging must share the admitted filesystem.");
    const { archiveBytes, contents, database } = input.receipt.staging;
    if (input.receipt.object.bytes !== archiveBytes + 41) throw new Error("Off-node encrypted footprint differs.");
    const reserved = copies(archiveBytes, contents, database, disk.block, true);
    reserved.bytes += input.journalBytes + 4 * disk.block;
    reserved.files += 4;
    requirePrivateJsonCapacity(
      { generation: randomUUID(), identity, amount: reserved, materialized: reserved },
      65_536,
    );
    let record = await read(path);
    if (record && record.identity !== identity) throw new Error("Restore capacity operation differs.");
    const allocation = allocated(database, disk.block);
    const databaseBudget = {
      bytes: allocation.bytes + DATABASE_WORK.bytes,
      files: allocation.files + DATABASE_WORK.files,
    };
    return {
      databaseBudget,
      verification: { scratch: join(input.directory, "verify"), databaseBudget },
      async admit(journalBytes = 0) {
        reserved.bytes += journalBytes;
        const outstanding = { bytes: 0, files: 0 };
        const used = { bytes: 0, files: 0 };
        for (const name of await readdir(join(input.root, "restores"))) {
          z.uuid().parse(name);
          if (join(input.root, "restores", name) === input.directory) continue;
          const other = await read(join(input.root, "restores", name, "capacity.json"));
          if (other) {
            used.bytes += other.amount.bytes;
            used.files += other.amount.files;
            outstanding.bytes += other.amount.bytes - other.materialized.bytes;
            outstanding.files += other.amount.files - other.materialized.files;
          }
        }
        const actual = await materialized(input.paths);
        if (actual.bytes > reserved.bytes || actual.files > reserved.files)
          throw new Error("Restore staging exceeds its admitted capacity.");
        const current = await stagingDisk(input.root, input.staging);
        if (reserved.bytes + used.bytes > current.maximum.bytes || reserved.files + used.files > current.maximum.files)
          throw new Error("Off-node staging capacity is exhausted.");
        checkStagingCapacity(
          { bytes: Math.max(0, reserved.bytes - actual.bytes), files: Math.max(0, reserved.files - actual.files) },
          current,
          outstanding,
        );
        record = { generation: record?.generation ?? randomUUID(), identity, amount: reserved, materialized: actual };
        await writePrivateJson(path, record, 65_536);
      },
      async materialize() {
        if (!record) throw new Error("Restore capacity was not admitted.");
        const actual = await materialized(input.paths);
        if (actual.bytes > record.amount.bytes || actual.files > record.amount.files)
          throw new Error("Restore exceeds its admitted capacity.");
        record.materialized = actual;
        await writePrivateJson(path, record, 65_536);
      },
      async release(scratch: string[]) {
        const existing = await read(path);
        if (existing && !isDeepStrictEqual(existing.identity, identity))
          throw new Error("Restore capacity operation differs.");
        for (const path of scratch) {
          try {
            await lstat(path);
            throw new Error("Restore staging still exists.");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          syncDirectory(dirname(path));
        }
        await rm(path, { force: true });
        syncDirectory(input.directory);
      },
      close() {
        closeSync(descriptor);
      },
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
