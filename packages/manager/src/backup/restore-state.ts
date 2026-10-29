import { OffNodeBackupReceiptSchema } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";

export const RestoreResult = z.object({
  directory: z.literal("/private/pc_data"),
  recovery: z.object({ snapshotId: z.uuid(), recoveryId: z.uuid() }).passthrough(),
  checkpoints: z.number().int().nonnegative(),
  writer: OffNodeBackupReceiptSchema.shape.sourceWriter,
});
export const RestorationStatus = z.strictObject({
  operation_id: z.uuid(),
  snapshot_id: z.uuid(),
  complete: z.boolean(),
  writer: OffNodeBackupReceiptSchema.shape.sourceWriter,
  current_journal: OffNodeBackupReceiptSchema.shape.journal,
});
