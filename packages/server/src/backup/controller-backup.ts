import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { PGliteStore } from "@pstdio/pocketcoder-db";
import type { Hono } from "hono";
import { z } from "zod";
import type { Maintenance } from "../maintenance/maintenance";

const BackupRequestSchema = z.strictObject({
  output: z.string().min(2).max(4096).startsWith("/"),
  timeout_ms: z.number().int().min(100).max(300_000).default(30_000),
});
type BackupRequest = z.infer<typeof BackupRequestSchema>;

// Base64url forms of the 32-byte files in pc_data/keys.
export interface ControllerKeys {
  pepper: string;
  eventSigningKey: string;
  secretKey: string;
}

export function createControllerBackup(deps: {
  store: PGliteStore;
  maintenance: Maintenance;
  keys?: ControllerKeys;
  checkpointDirectory?: string;
}) {
  return async (input: BackupRequest, signal: AbortSignal) => {
    if (!deps.keys)
      throw new ApiError("backup.failed", "Backup requires the controller key bundle in the data folder.");
    const { pepper, eventSigningKey, secretKey } = deps.keys;
    try {
      const receipt = await deps.store.backup({
        output: input.output,
        ...(deps.checkpointDirectory ? { checkpointDirectory: deps.checkpointDirectory } : {}),
        // The live keys are the identity the database was written with.
        keys: {
          "auth-pepper": Buffer.from(pepper, "base64url"),
          "event-signing-key": Buffer.from(eventSigningKey, "base64url"),
          "secret-key": Buffer.from(secretKey, "base64url"),
        },
        signal,
        freeze: (capture) => deps.maintenance.run(input.timeout_ms, signal, capture),
      });
      return {
        output: receipt.path,
        bytes: receipt.bytes,
        digest: receipt.digest,
        snapshot_id: receipt.snapshotId,
        position: receipt.position,
        checkpoints: receipt.checkpoints,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError("backup.failed", error instanceof Error ? error.message : String(error));
    }
  };
}
export type ControllerBackup = ReturnType<typeof createControllerBackup>;

export function registerBackupRoute(app: Hono, backup: ControllerBackup) {
  app.post("/v1/backup", async (context) => {
    const parsed = BackupRequestSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError("validation.invalid", "Invalid backup request.");
    return context.json(await backup(parsed.data, context.req.raw.signal), 201);
  });
}
