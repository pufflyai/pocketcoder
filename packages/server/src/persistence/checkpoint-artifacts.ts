import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceCheckpointRow } from "@pstdio/pocketcoder-runtime-core";
import type { PersistenceContext } from "./persistence-base";

// The workspace wrote this tree, so no segment may be a link that points outside it.
function readCheckpointFile(root: string, mount: string, path: string, maxBytes: number) {
  let current = join(root, mount);
  for (const segment of path.split("/")) {
    if (!lstatSync(current).isDirectory()) return null;
    current = join(current, segment);
    try {
      lstatSync(current);
    } catch {
      return null;
    }
  }
  const file = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(file);
    if (!info.isFile()) return null;
    if (info.size > maxBytes) throw new ApiError("artifact.too_large", "The artifact exceeds its declared size limit.");
    const bytes = Buffer.alloc(info.size);
    let read = 0;
    while (read < info.size) read += readSync(file, bytes, read, info.size - read, read);
    return bytes;
  } finally {
    closeSync(file);
  }
}

export async function readCheckpointArtifact(
  context: PersistenceContext,
  checkpoint: WorkspaceCheckpointRow,
  mount: string,
  path: string,
  maxBytes: number,
) {
  try {
    if (checkpoint.providerKind === "controller-archive" && context.deps.checkpointTransfers)
      return await context.deps.checkpointTransfers.readFile(checkpoint, mount, path, maxBytes);
    if (checkpoint.providerKind === "filesystem" && typeof checkpoint.providerRef?.root === "string")
      return readCheckpointFile(checkpoint.providerRef.root, mount, path, maxBytes);
  } catch (error) {
    if (error instanceof Error && error.message === "artifact.too_large")
      throw new ApiError("artifact.too_large", "The artifact exceeds its declared size limit.");
    throw error;
  }
  throw new ApiError("checkpoint.unsupported", "This checkpoint's storage backend cannot serve artifacts.", {
    provider_kind: checkpoint.providerKind,
  });
}
