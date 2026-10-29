import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { type CheckpointArchiveEntry, readCheckpointArchive } from "@pstdio/pocketcoder-contracts";
import { openCheckpointArchivePublication } from "@pstdio/pocketcoder-db/checkpoints";
import type { Store, WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-core";
import type { TransferLifetime } from "./checkpoint-transfer-lifetime";

export function createCheckpointTransferMaintenance(store: Store, lifetime: TransferLifetime, directory: string) {
  async function publication(checkpoint: WorkspaceCheckpointRow) {
    const row = await store.checkpointTransfers.publication(checkpoint.id);
    if (
      !row?.stagePath ||
      !row.stageIdentity ||
      row.principalId !== checkpoint.principalId ||
      row.workspaceId !== checkpoint.workspaceId ||
      checkpoint.providerRef?.archivePath !== row.stagePath ||
      checkpoint.providerRef?.transferId !== row.id ||
      row.archiveDigest === null ||
      row.storedBytes !== checkpoint.storedBytes
    )
      throw new Error("Checkpoint publication metadata differs from its catalog.");
    return row;
  }
  return {
    // One file from a published archive, read with the archive's own digest checks.
    async readFile(checkpoint: WorkspaceCheckpointRow, mountName: string, path: string, maxBytes: number) {
      const row = await publication(checkpoint);
      const owner = openCheckpointArchivePublication(
        directory,
        row.stagePath as string,
        row.stageIdentity as NonNullable<typeof row.stageIdentity>,
        () => {},
      );
      let mount = -1;
      let match: CheckpointArchiveEntry | undefined;
      const chunks: Buffer[] = [];
      let size = 0;
      const found = new Error("found");
      try {
        await readCheckpointArchive(owner.stream(), {
          maxArchiveBytes: row.storedBytes ?? 0,
          async onHeader(header) {
            mount = header.mounts.findIndex((item) => item.name === mountName);
          },
          async onEntry(entry) {
            if (entry.kind === "file" && entry.mount === mount && entry.path === path) {
              if (entry.size > maxBytes) throw new Error("artifact.too_large");
              match = entry;
            }
          },
          async onData(entry, bytes) {
            if (entry !== match) return;
            chunks.push(Buffer.from(bytes));
            size += bytes.length;
          },
          async onEntryComplete(entry) {
            if (entry === match) throw found;
          },
        });
        return null;
      } catch (error) {
        if (error === found) return Buffer.concat(chunks, size);
        throw error;
      } finally {
        await owner.close();
      }
    },
    async inventory() {
      const rows = await store.checkpointTransfers.listUnsettled();
      const paths = new Set(rows.flatMap((row) => (row.stagePath ? [row.stagePath] : [])));
      const allocations = await Promise.all(
        (await store.listNonterminal()).map((workspace) => store.getWorkspaceStorage(workspace.id)),
      );
      return {
        backend: "controller-archive",
        storage_count: allocations.filter((row) => row && row.state !== "deleted").length,
        checkpoint_count: rows.filter((row) => row.direction === "upload" && row.state === "complete").length,
        unknown_storage: [] as string[],
        unknown_checkpoints: (await readdir(directory)).filter((path) => !paths.has(path)).sort(),
      };
    },
    async verify(checkpoint: WorkspaceCheckpointRow) {
      const row = await publication(checkpoint);
      const owner = openCheckpointArchivePublication(
        directory,
        row.stagePath as string,
        row.stageIdentity as NonNullable<typeof row.stageIdentity>,
        () => {},
      );
      const reader = owner.stream().getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          hash.update(part.value);
        }
        owner.validate();
        if (bytes !== row.storedBytes || `sha256:${hash.digest("hex")}` !== row.archiveDigest)
          throw new Error("Checkpoint archive content differs from its publication receipt.");
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await owner.close();
      }
    },
    async delete(checkpoint: WorkspaceCheckpointRow) {
      const row = await publication(checkpoint);
      const contexts = [...lifetime.active.values()].filter((context) => context.row.checkpointId === checkpoint.id);
      for (const context of contexts) await lifetime.cleanup(context);
      const owner = openCheckpointArchivePublication(
        directory,
        row.stagePath as string,
        row.stageIdentity as NonNullable<typeof row.stageIdentity>,
        () => {},
      );
      let removed = false;
      try {
        await store.checkpointTransfers.removePublication(row.id, () => {
          if (!removed) {
            owner.remove();
            removed = true;
          }
          owner.checkRemoved();
        });
      } finally {
        await owner.close();
      }
    },
  };
}
