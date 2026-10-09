import { z } from "zod";
import { CheckpointArchiveHeaderSchema } from "../checkpoints/archive-format";
import { PersistenceMountSchema } from "../persistence/persistence";

export const CHECKPOINT_TRANSFER_MIN_PROTOCOL_VERSION = 7;
const bytes = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const PrepareCheckpointArchivePayload = z.object({
  operation_id: z.uuid(),
  checkpoint_id: z.uuid(),
  deadline_ms: bytes,
  mounts: z.array(PersistenceMountSchema).max(16),
  max_archive_bytes: bytes,
  max_index_bytes: bytes,
  max_queue_bytes: bytes,
});
export type PrepareCheckpointArchive = z.infer<typeof PrepareCheckpointArchivePayload>;

export const CheckpointPreparedPayload = z
  .object({
    operation_id: z.uuid(),
    checkpoint_id: z.uuid(),
    header: CheckpointArchiveHeaderSchema,
    archive_bytes: bytes,
  })
  .refine((value) => value.header.checkpoint_id === value.checkpoint_id, "Checkpoint declaration identity differs.");
export type CheckpointPrepared = z.infer<typeof CheckpointPreparedPayload>;

const grant = z.object({
  operation_id: z.uuid(),
  transfer_id: z.uuid(),
  checkpoint_id: z.uuid(),
  credential: z.string().min(1).max(4096),
  url: z.url(),
  expires_at: z.iso.datetime(),
});
export const CheckpointUploadPayload = grant;
export type CheckpointUpload = z.infer<typeof CheckpointUploadPayload>;

export const RestoreTransferSpecSchema = grant
  .extend({
    source: z.object({
      checkpoint_id: z.uuid(),
      workspace_id: z.uuid(),
      template_digest: digest,
      archive_digest: digest,
    }),
    mounts: z.array(PersistenceMountSchema).max(16),
    max_archive_bytes: bytes,
    max_index_bytes: bytes,
    max_ledger_bytes: bytes,
  })
  .refine((value) => value.source.checkpoint_id === value.checkpoint_id, "Restore source identity differs.");
export type RestoreTransferSpec = z.infer<typeof RestoreTransferSpecSchema>;

export const CheckpointInstalledPayload = z.object({
  operation_id: z.uuid(),
  transfer_id: z.uuid(),
  checkpoint_id: z.uuid(),
  archive_digest: digest,
  phase: z.enum(["installed", "failed"]),
});
export type CheckpointInstalled = z.infer<typeof CheckpointInstalledPayload>;

export const CheckpointUploadStatusPayload = z.object({
  operation_id: z.uuid(),
  transfer_id: z.uuid(),
  checkpoint_id: z.uuid(),
  phase: z.enum(["uploaded", "failed"]),
});
