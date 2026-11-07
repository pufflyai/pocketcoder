import { randomUUID } from "node:crypto";
import {
  ApiError,
  digestOf,
  finiteOutputMounts,
  sha256Hex,
  type WorkloadExportReference,
} from "@pstdio/pocketcoder-contracts";
import type {
  ExportExtraction,
  ReadStorageCapacity,
  StorageRef,
  Store,
  WorkspaceRow,
  WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";

// The scheduler invokes this only after stopping the exact provider incarnation.
// A database commit publishes bytes, manifest and finalization together. A crash
// before that point leaves no public export; retry reads the stopped allocation.
export function finiteExports(deps: {
  store: Store;
  storageDriver?: WorkspaceStorageDriver;
  now?: () => Date;
  readCapacity?: ReadStorageCapacity;
}) {
  return async (row: WorkspaceRow) => {
    if (row.runtimeRegistration?.profile !== "finite-process") return;
    const current = await deps.store.getWorkspace(row.id);
    if (current?.purgeRequestedAt) return;
    const record = current?.processExecution;
    const spec = row.runtimeRegistration.template?.manifest.spec;
    if (!record || !spec) return;
    if (record.collection) {
      await completeExtraction(deps, row.id);
      return;
    }
    const at = deps.now?.() ?? new Date();
    const started = Date.parse(record.cancel?.requestedAt ?? record.settledAt ?? row.deadlineAt.toISOString());
    const deadline = Math.min(
      row.deadlineAt.getTime() + spec.limits.finalizationSeconds * 1000,
      started + spec.limits.finalizationSeconds * 1000,
    );
    const mounts = finiteOutputMounts(spec);
    const extraction = await extract(
      deps,
      row,
      mounts.map((mount) => mount.name),
      deadline,
      at,
      spec.limits,
    );
    if (["lost", "unknown"].includes(record.phase)) extraction.errors.push("workload_lost");
    const files = extraction.files.flatMap((file) => {
      let name = file.name;
      for (const mount of mounts)
        if (name.startsWith(`${mount.name}/`)) name = mount.target.slice(1) + name.slice(mount.name.length);
      if (name.length > 255) {
        extraction.errors.push("export_name_limit");
        return [];
      }
      return [{ ...file, name, objectId: randomUUID() }];
    });
    const objects = files.map((file) => {
      const digest = `sha256:${sha256Hex(file.bytes)}`;
      return {
        objectId: file.objectId,
        objectVersion: digest,
        digest,
        name: file.name,
        sizeBytes: file.bytes.length,
        mediaType: "application/octet-stream" as const,
      };
    });
    let completeness: WorkloadExportReference["completeness"] = "complete";
    if (extraction.errors.length) completeness = objects.length ? "partial" : "lost";
    const core = { execution: record.acceptance.execution, objects, completeness, errors: extraction.errors };
    const manifest: WorkloadExportReference = {
      ...core,
      exportId: randomUUID(),
      manifestDigest: digestOf(core),
      publication: "published",
      cleanupState: "pending",
      publishedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + spec.limits.exportRetentionSeconds * 1000).toISOString(),
    };
    const capacity = await deps.readCapacity?.();
    await commit(deps.store, manifest, files, at, capacity);
    await completeExtraction(deps, row.id);
  };
}

async function commit(
  store: Store,
  manifest: WorkloadExportReference,
  files: { objectId: string; bytes: Uint8Array }[],
  at: Date,
  capacity: Awaited<ReturnType<ReadStorageCapacity>> | undefined,
) {
  try {
    await store.exports.commit(manifest, files, at, capacity);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "storage.capacity_exhausted") throw error;
    const lost = {
      execution: manifest.execution,
      objects: [],
      completeness: "lost" as const,
      errors: ["storage_capacity_exhausted"],
    };
    await store.exports.commit({ ...manifest, ...lost, manifestDigest: digestOf(lost) }, [], at);
  }
}

async function extract(
  deps: { store: Store; storageDriver?: WorkspaceStorageDriver },
  row: WorkspaceRow,
  mounts: string[],
  deadline: number,
  at: Date,
  limits: { exportBytes: number; exportFiles: number },
): Promise<ExportExtraction> {
  if (at.getTime() >= deadline) return { files: [], errors: ["finalization_expired"] };
  if (!mounts.length) return { files: [], errors: [] };
  const storage = await deps.store.getWorkspaceStorage(row.id);
  if (!storage?.providerRef || !deps.storageDriver?.readExports) return { files: [], errors: ["storage_unavailable"] };
  try {
    return await deps.storageDriver.readExports(
      storage.providerRef as StorageRef,
      mounts,
      { bytes: limits.exportBytes, files: limits.exportFiles },
      AbortSignal.timeout(Math.max(1, deadline - at.getTime())),
    );
  } catch {
    return { files: [], errors: ["extraction_failed"] };
  }
}

async function completeExtraction(deps: { store: Store; storageDriver?: WorkspaceStorageDriver }, id: string) {
  const storage = await deps.store.getWorkspaceStorage(id);
  if (storage?.providerRef) await deps.storageDriver?.completeExtraction?.(storage.providerRef as StorageRef);
}

export function finiteExportCleanup(store: Store) {
  return async (row: WorkspaceRow) => {
    if (row.runtimeRegistration?.profile !== "finite-process") return;
    const record = (await store.getWorkspace(row.id))?.processExecution;
    if (record?.collection) await store.exports.completeCleanup(record.acceptance.execution);
  };
}
