import {
  type CheckpointArchiveHeader,
  type PersistenceMount,
  PersistenceMountSchema,
} from "@pstdio/pocketcoder-contracts";

export interface CheckpointDownloadBinding {
  source: { checkpointId: string; workspaceId: string; templateDigest: string; archiveDigest: string };
  destination: { workspaceId: string; operationId: string };
}

export interface CheckpointDownloadMount {
  parent: string;
  policy: PersistenceMount;
}

export function authorizeCheckpointDownload(
  header: CheckpointArchiveHeader,
  binding: CheckpointDownloadBinding,
  mounts: readonly CheckpointDownloadMount[],
) {
  if (
    header.checkpoint_id !== binding.source.checkpointId ||
    header.workspace_id !== binding.source.workspaceId ||
    header.template_digest !== binding.source.templateDigest
  )
    throw new Error("Checkpoint source does not match the admitted restore operation.");
  if (header.mounts.length !== mounts.length) throw new Error("Checkpoint mount count does not match admission.");
  for (let ordinal = 0; ordinal < mounts.length; ordinal++) {
    const mount = mounts[ordinal];
    const actual = header.mounts[ordinal];
    if (!mount || !actual) throw new Error("Checkpoint mount is missing.");
    const policy = PersistenceMountSchema.parse(mount.policy);
    if (actual.name !== policy.name) throw new Error("Checkpoint mount order does not match admission.");
    if (actual.logical_bytes > policy.maxBytes) throw new Error("Checkpoint mount exceeds maxBytes.");
    if (actual.file_count > policy.maxFiles) throw new Error("Checkpoint mount exceeds maxFiles.");
  }
}
