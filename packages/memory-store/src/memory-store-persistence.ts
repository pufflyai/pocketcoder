import type { CheckpointState } from "@pstdio/pocketcoder-contracts";
import type {
  WorkspaceCheckpointPatch,
  WorkspaceCheckpointRow,
  WorkspaceStoragePatch,
  WorkspaceStorageRow,
} from "@pstdio/pocketcoder-runtime-contracts";
import { MemoryWarmPoolStore } from "./memory-store-warm-pools";

export class MemoryPersistenceStore extends MemoryWarmPoolStore {
  async insertWorkspaceStorage(row: WorkspaceStorageRow): Promise<WorkspaceStorageRow> {
    const existing = [...this.storage.values()].find(
      (candidate) =>
        candidate.workspaceId === row.workspaceId &&
        !["deleted", "lost", "quarantined"].includes(candidate.state),
    );
    if (existing) return { ...existing };
    this.storage.set(row.id, { ...row });
    return { ...row };
  }

  async getWorkspaceStorage(workspaceId: string): Promise<WorkspaceStorageRow | null> {
    const row = [...this.storage.values()].find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        !["deleted", "lost", "quarantined"].includes(candidate.state),
    );
    return row ? { ...row } : null;
  }

  async getStorage(id: string): Promise<WorkspaceStorageRow | null> {
    const row = this.storage.get(id);
    return row ? { ...row } : null;
  }

  async updateWorkspaceStorage(id: string, patch: WorkspaceStoragePatch, at: Date): Promise<void> {
    const row = this.storage.get(id);
    if (!row) return;
    Object.assign(row, patch);
    row.updatedAt = at;
  }

  async insertCheckpoint(row: WorkspaceCheckpointRow): Promise<WorkspaceCheckpointRow> {
    const existing = this.checkpoints.get(row.id);
    if (existing) return { ...existing };
    this.checkpoints.set(row.id, { ...row });
    return { ...row };
  }

  async getCheckpoint(id: string): Promise<WorkspaceCheckpointRow | null> {
    const row = this.checkpoints.get(id);
    return row ? { ...row } : null;
  }

  async listCheckpoints(
    principalId: string,
    filter: { workspaceId?: string; state?: CheckpointState } = {},
  ): Promise<WorkspaceCheckpointRow[]> {
    return [...this.checkpoints.values()]
      .filter(
        (row) =>
          row.principalId === principalId &&
          (!filter.workspaceId || row.workspaceId === filter.workspaceId) &&
          (!filter.state || row.state === filter.state),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => ({ ...row }));
  }

  async updateCheckpoint(id: string, patch: WorkspaceCheckpointPatch, at: Date): Promise<void> {
    const row = this.checkpoints.get(id);
    if (!row) return;
    if (row.state === "ready") {
      const mutable = new Set(["state", "reasonCode", "expiresAt", "deletedAt"]);
      for (const key of Object.keys(patch)) {
        if (!mutable.has(key)) throw new Error("ready checkpoints are immutable");
      }
    }
    Object.assign(row, patch);
    row.updatedAt = at;
  }
}
