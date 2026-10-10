import { z } from "zod";
import { JournalCursorSchema } from "../journal/events";

// Set by restore. While present, the controller only serves local recovery access.
export const RecoveryStateSchema = z.strictObject({
  format: z.literal("pocketcoder-recovery/v1"),
  recoveryId: z.uuid(),
  snapshotId: z.uuid(),
  // The journal position the backup describes; the journal must reach it before recovery can finish.
  journal: JournalCursorSchema,
  createdAt: z.iso.datetime(),
});
export type RecoveryState = z.infer<typeof RecoveryStateSchema>;
