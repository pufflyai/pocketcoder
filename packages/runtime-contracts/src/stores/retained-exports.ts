import type { WorkloadExportReference } from "@pstdio/pocketcoder-contracts";
import type { StorageCapacity } from "./storage-reservations";

export interface RetainedExportStore {
  commit(
    manifest: WorkloadExportReference,
    files: { objectId: string; bytes: Uint8Array }[],
    at: Date,
    capacity?: StorageCapacity,
  ): Promise<WorkloadExportReference>;
  completeCleanup(execution: WorkloadExportReference["execution"]): Promise<void>;
  content(workspaceId: string, objectId: string, principalId: string, at: Date): Promise<Uint8Array | null>;
  delete(
    execution: WorkloadExportReference["execution"],
    exportId: string,
    principalId: string,
    at: Date,
  ): Promise<void>;
  prune(at: Date): Promise<void>;
}
