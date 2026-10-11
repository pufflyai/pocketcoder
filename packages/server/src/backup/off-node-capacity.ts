import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceWriterSchema } from "@pstdio/pocketcoder-contracts";
import type { PGliteStore } from "@pstdio/pocketcoder-db";
import type { BackupManifest } from "@pstdio/pocketcoder-db/backup";
import {
  allocated,
  checkStagingCapacity,
  copies,
  DATABASE_WORK,
  manifestFootprint,
  materialized,
  type OffNode,
  readPrivateFile,
  STAGING_HEADROOM,
  StagingFootprintSchema,
  type StagingPolicy,
  stagingDisk,
  writePrivateJson,
} from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import type { ControllerBackup } from "./controller-backup";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CaptureIntent = z.strictObject({
  accountId: z.uuid(),
  operationId: z.uuid(),
  writer: SourceWriterSchema,
  reservationId: z.uuid(),
  limit: z.strictObject({ bytes: integer, members: integer }),
  contents: StagingFootprintSchema,
  database: StagingFootprintSchema,
  amount: z.strictObject({ bytes: integer, files: integer }),
});
type CaptureIntent = z.infer<typeof CaptureIntent>;
export function capturePaths(directory: string) {
  return ["backup.tar", "backup.enc", "backup.enc.check", ".backup.tar.partial", "verify"].map((name) =>
    join(directory, name),
  );
}

interface CaptureInput {
  store: PGliteStore;
  offNode: OffNode;
  backup: ControllerBackup;
  staging?: StagingPolicy;
}
async function captureIntent(input: CaptureInput, directory: string, operationId: string) {
  const { store, offNode } = input;
  const policy = input.staging ?? offNode.config.staging;
  const identity = { accountId: offNode.config.accountId, operationId, writer: store.journalSnapshot().writer };
  const path = join(directory, "intent.json");
  let intent: CaptureIntent;
  try {
    intent = CaptureIntent.parse(JSON.parse((await readPrivateFile(path, 65_536)).toString()));
    if (
      !isDeepStrictEqual(
        { accountId: intent.accountId, operationId: intent.operationId, writer: intent.writer },
        identity,
      )
    )
      throw new Error("Off-node backup source intent differs.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const footprint = await input.backup.footprint();
    const contents = {
      bytes: footprint.contents.bytes + 16 * 1024 ** 2,
      files: footprint.contents.files + 16,
      directories: footprint.contents.directories + 16,
    };
    const database = {
      bytes: footprint.database.bytes + 16 * 1024 ** 2,
      files: footprint.database.files + 16,
      directories: footprint.database.directories + 16,
    };
    const limit = {
      bytes: contents.bytes + contents.files * 511 + (contents.files + contents.directories + 1) * 512 + 1024,
      members: contents.files + contents.directories + 1,
    };
    const disk = await stagingDisk(directory, policy);
    intent = {
      ...identity,
      reservationId: randomUUID(),
      limit,
      contents,
      database,
      amount: copies(limit.bytes, contents, database, disk.block, false),
    };
    await writePrivateJson(path, intent, 65_536);
  }
  return intent;
}

export async function admitCapture(input: CaptureInput, directory: string, operationId: string, check: () => void) {
  const { store, offNode } = input;
  const policy = input.staging ?? offNode.config.staging;
  let intent = await captureIntent(input, directory, operationId);
  let row = await store.storageReservations.get(intent.reservationId);
  if (row && !(await Bun.file(join(directory, "backup.tar")).exists())) {
    // A new capture gets a new bound only after the old generation's actual scratch is gone.
    await releaseCapture(store, directory, intent.reservationId);
    intent = await captureIntent(input, directory, operationId);
    row = null;
  }
  if (!row)
    await store.storageReservations.reserve(
      {
        id: intent.reservationId,
        purpose: "backup",
        operationId: null,
        workspaceId: null,
        principalId: null,
        reservedBytes: intent.amount.bytes,
        reservedFiles: intent.amount.files,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      async () => {
        const disk = await stagingDisk(directory, policy);
        const unbounded = { bytes: Number.MAX_SAFE_INTEGER, files: Number.MAX_SAFE_INTEGER };
        return {
          instance: disk.maximum,
          principal: unbounded,
          workspace: unbounded,
          freeDisk: {
            bytes: disk.bytes,
            files: disk.files,
            headroomBytes: STAGING_HEADROOM.bytes,
            headroomFiles: STAGING_HEADROOM.files,
          },
        };
      },
      check,
    );
  else if (
    row.purpose !== "backup" ||
    row.state !== "reserved" ||
    row.reservedBytes !== intent.amount.bytes ||
    row.reservedFiles !== intent.amount.files
  )
    throw new Error("Off-node backup staging reservation differs.");
  const disk = await stagingDisk(directory, policy);
  const databaseAllocation = allocated(intent.database, disk.block);
  return {
    intent,
    verification: {
      scratch: join(directory, "verify"),
      databaseBudget: {
        bytes: databaseAllocation.bytes + DATABASE_WORK.bytes,
        files: databaseAllocation.files + DATABASE_WORK.files,
      },
    },
    async materialize() {
      const actual = await materialized(capturePaths(directory));
      await store.storageReservations.materialize(intent.reservationId, actual, check);
      const usage = await store.storageReservations.usage(null, null);
      checkStagingCapacity({ bytes: 0, files: 0 }, await stagingDisk(directory, policy), usage.outstanding);
    },
    footprint(manifest: BackupManifest) {
      const contents = manifestFootprint(manifest);
      const database = manifestFootprint(manifest, true);
      for (const [actual, admitted] of [
        [contents, intent.contents],
        [database, intent.database],
      ] as const)
        if (actual.bytes > admitted.bytes || actual.files > admitted.files || actual.directories > admitted.directories)
          throw new Error("Backup footprint exceeds its admitted capacity.");
      return { reservationId: intent.reservationId, archiveBytes: 0, contents, database };
    },
  };
}

export async function releaseCapture(store: PGliteStore, directory: string, reservationId: string) {
  const row = await store.storageReservations.get(reservationId);
  if (row && (row.purpose !== "backup" || row.operationId || row.workspaceId || row.principalId))
    throw new Error("Off-node backup staging owner differs.");
  for (const path of capturePaths(directory)) await rm(path, { recursive: true, force: true });
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  if (row && row.state !== "released") {
    await store.storageReservations.beginRelease(reservationId, () => {});
    await store.storageReservations.release(reservationId, () => {
      if (capturePaths(directory).some(existsSync)) throw new Error("Off-node backup staging still exists.");
    });
  }
  await rm(join(directory, "intent.json"), { force: true });
  const cleaned = await open(directory, "r");
  try {
    await cleaned.sync();
  } finally {
    await cleaned.close();
  }
}
