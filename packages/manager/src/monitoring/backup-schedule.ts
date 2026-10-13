import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateFile } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { ManagerReceiptSchema } from "../recovery/manifest";
import type { prometheus } from "./prometheus";

export const ManagerBackupScheduleSchema = z.strictObject({
  operationId: z.uuid().optional(),
  attemptedAt: z.iso.datetime(),
  result: z.enum(["started", "succeeded", "failed"]),
  receiptFile: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T(?:00|12)\.receipt\.json$/)
    .optional(),
});

export async function readManagerBackupSchedule(directory: string) {
  const folder = await lstat(directory);
  if (!folder.isDirectory() || (folder.mode & 0o777) !== 0o700)
    throw new Error("Manager backup observations require a private directory.");
  const file = join(directory, "health.json");
  if (!existsSync(file)) return null;
  return ManagerBackupScheduleSchema.parse(JSON.parse((await readPrivateFile(file, 4096)).toString()));
}

export function managerBackupProbe(directory: string, journalId: string) {
  return async () => {
    const schedule = await readManagerBackupSchedule(directory);
    let recoveryPoint: Date | null = null;
    if (schedule?.receiptFile) {
      const receipt = ManagerReceiptSchema.parse(
        JSON.parse((await readPrivateFile(join(directory, schedule.receiptFile), 16 * 1024 ** 2)).toString()),
      );
      if (receipt.journal.journalId !== journalId) throw new Error("Manager backup journal identity differs.");
      recoveryPoint = new Date(receipt.createdAt);
    }
    return {
      recoveryPoint,
      failed: schedule?.result === "failed",
      startedAt: schedule?.result === "started" ? new Date(schedule.attemptedAt) : null,
    };
  };
}

export type ManagerBackupObservation = Awaited<ReturnType<ReturnType<typeof managerBackupProbe>>>;
export interface ManagerBackupSample {
  at: number;
  value: ManagerBackupObservation;
}

export function managerBackupMetrics(
  output: ReturnType<typeof prometheus>,
  configured: boolean,
  backup: ManagerBackupSample | null,
  now: number,
) {
  output.add("manager_backup_configured", configured ? 1 : 0);
  output.add("manager_backup_observed", backup ? 1 : 0);
  output.add("manager_backup_observation_age_seconds", backup ? Math.max(0, now - backup.at) : null);
  if (backup) {
    const point = backup.value.recoveryPoint;
    const started = backup.value.startedAt;
    output.add("manager_backup_present", point ? 1 : 0);
    output.add("manager_backup_age_seconds", point ? Math.max(0, now - point.getTime() / 1000) : null);
    output.add("manager_backup_failed", backup.value.failed ? 1 : 0);
    output.add("manager_backup_in_progress_seconds", started ? Math.max(0, now - started.getTime() / 1000) : 0);
  } else {
    for (const name of ["present", "age_seconds", "failed", "in_progress_seconds"])
      output.add(`manager_backup_${name}`, null);
  }
}
