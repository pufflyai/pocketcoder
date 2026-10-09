import type { CheckpointArchiveHeader, CheckpointArchiveSummary } from "@pstdio/pocketcoder-contracts";
import type { ReadStorageCapacity } from "./storage-reservations";

export const CHECKPOINT_TRANSFER_STATES = [
  "preparing",
  "granted",
  "streaming",
  "validated",
  "publishing",
  "complete",
  "cleanup_pending",
  "aborted",
] as const;

export interface CheckpointStageIdentity {
  device: string;
  inode: string;
  uid: number;
  gid: number;
  mode: number;
  allocatedBytes: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface CheckpointTransferRow {
  id: string;
  operationId: string;
  checkpointId: string;
  workspaceId: string;
  principalId: string;
  direction: "upload" | "download";
  connectionEpoch: number;
  state: (typeof CHECKPOINT_TRANSFER_STATES)[number];
  requestDigest: string;
  grantDigest: Uint8Array | null;
  expiresAt: Date;
  reservationId: string | null;
  stagePath: string | null;
  stageIdentity: CheckpointStageIdentity | null;
  declaredHeader: CheckpointArchiveHeader | null;
  expectedArchiveBytes: number | null;
  summary: CheckpointArchiveSummary | null;
  archiveDigest: string | null;
  storedBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CheckpointRetentionLimits {
  maxCheckpointFiles: number;
  maxRetainedBytes: number;
  maxRetainedBytesPerPrincipal: number;
  maxCheckpointsPerPrincipal: number;
}

export interface CheckpointUploadGrant {
  retentionLimits: CheckpointRetentionLimits;
  id: string;
  operationId: string;
  checkpointId: string;
  workspaceId: string;
  connectionEpoch: number;
  header: CheckpointArchiveHeader;
  expectedArchiveBytes: number;
  grantDigest: Uint8Array;
  expiresAt: Date;
  reservationId: string;
  reservedBytes: number;
  reservedFiles: number;
}

export type CheckpointDownloadGrant = Pick<
  CheckpointUploadGrant,
  "id" | "operationId" | "checkpointId" | "workspaceId" | "connectionEpoch" | "grantDigest" | "expiresAt"
>;

export interface CheckpointTransferClaim {
  id: string;
  operationId: string;
  workspaceId: string;
  direction: "upload" | "download";
  connectionEpoch: number;
  grantDigest: Uint8Array;
}

export interface CheckpointPublication {
  summary: CheckpointArchiveSummary;
  archiveDigest: string;
  storedBytes: number;
  stagePath: string;
  stageIdentity: CheckpointStageIdentity;
}

export interface CheckpointTransferStore {
  listUnsettled(): Promise<CheckpointTransferRow[]>;
  stage(
    id: string,
    receipt: Pick<CheckpointPublication, "stagePath" | "stageIdentity">,
    check: () => void,
  ): Promise<CheckpointTransferRow>;
  completeRestore(workspaceId: string, connectionEpoch: number, check: () => void): Promise<boolean>;
  validate(id: string, check: () => void): Promise<CheckpointTransferRow>;
  publish(
    id: string,
    receipt: CheckpointPublication,
    check: () => void,
    retentionLimits: CheckpointRetentionLimits,
  ): Promise<CheckpointTransferRow>;
  downloaded(id: string, check: () => void): Promise<CheckpointTransferRow>;
  installed(id: string, check: () => void): Promise<CheckpointTransferRow>;
  abort(id: string, checkRemoved: () => void): Promise<CheckpointTransferRow>;
  removePublication(id: string, checkRemoved: () => void): Promise<CheckpointTransferRow>;
  publication(checkpointId: string): Promise<CheckpointTransferRow | null>;
  grantUpload(
    input: CheckpointUploadGrant,
    readCapacity: ReadStorageCapacity,
    check: () => void,
  ): Promise<CheckpointTransferRow>;
  grantDownload(input: CheckpointDownloadGrant, check: () => void): Promise<CheckpointTransferRow>;
  claim(input: CheckpointTransferClaim, check: () => void): Promise<CheckpointTransferRow>;
  get(id: string): Promise<CheckpointTransferRow | null>;
}
