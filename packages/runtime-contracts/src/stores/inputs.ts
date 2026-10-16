import type { AcceptedInputManifest, InputObjectReference } from "@pstdio/pocketcoder-contracts";
import type { ReadStorageCapacity } from "./storage-reservations";

export interface InputLimits {
  fileBytes: number;
  stagedBytes: number;
  files: number;
  transfers: number;
  transferMs: number;
  retentionMs: number;
}
export interface StoredInput {
  reference: InputObjectReference;
  principalId: string;
  reservationId: string;
  state: "uploading" | "ready" | "unavailable" | "releasing" | "expired";
  transferExpiresAt: Date;
  retainedUntil: Date;
  publishedAt: Date | null;
  retentionMs: number;
}
export interface InputClaim {
  retentionMs: number;
  reference: InputObjectReference;
  principalId: string;
  reservationId: string;
  transferExpiresAt: Date;
  retainedUntil: Date;
}
export interface InputManifestRow {
  id: string;
  manifest: AcceptedInputManifest;
  finalizedAt: Date | null;
}
export interface InputStore {
  begin(
    input: InputClaim,
    limits: InputLimits,
    capacity: ReadStorageCapacity,
  ): Promise<{ row: StoredInput; created: boolean }>;
  get(workspaceId: string, fileId: string): Promise<StoredInput | null>;
  list(): Promise<StoredInput[]>;
  publish(workspaceId: string, fileId: string, reservationId: string): Promise<StoredInput>;
  unavailable(workspaceId: string, fileId: string): Promise<void>;
  freeze(
    id: string,
    workspaceId: string,
    incarnationId: string,
    fileIds: string[],
    at: Date,
  ): Promise<InputManifestRow>;
  getManifest(id: string): Promise<InputManifestRow | null>;
  finalize(id: string, at: Date): Promise<void>;
  // Purge calls this only after proving all workspace providers stopped.
  finalizeForPurge(workspaceId: string, at: Date): Promise<void>;
  beginRelease(workspaceId: string, fileId: string, reservationId: string, at: Date): Promise<boolean>;
  release(workspaceId: string, fileId: string, reservationId: string): Promise<void>;
}
