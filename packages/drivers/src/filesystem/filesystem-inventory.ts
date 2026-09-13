import { open, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DiscoveredCheckpoint, DiscoveredStorage } from "@pstdio/pocketcoder-runtime-core";
import { makeWritable } from "./filesystem-checkpoint";

export const STORAGE_METADATA_FILE = ".pocketcoder-storage.json";
export const CHECKPOINT_METADATA_FILE = ".pocketcoder-checkpoint.json";

function childOf(root: string, id: string) {
  return resolve(root, id);
}

export async function discoverStorage(rootDirectory: string): Promise<DiscoveredStorage[]> {
  const result: DiscoveredStorage[] = [];
  for (const id of await readdir(rootDirectory)) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const root = childOf(rootDirectory, id);
    try {
      const metadata = JSON.parse(await readFile(join(root, STORAGE_METADATA_FILE), "utf8")) as {
        workspace_id?: unknown;
      };
      result.push({
        storageId: id,
        workspaceId: typeof metadata.workspace_id === "string" ? metadata.workspace_id : null,
        ref: { kind: "filesystem", id, root },
      });
    } catch {
      result.push({ storageId: id, workspaceId: null, ref: { kind: "filesystem", id, root } });
    }
  }
  return result;
}

export async function discoverCheckpoints(rootDirectory: string): Promise<DiscoveredCheckpoint[]> {
  const result: DiscoveredCheckpoint[] = [];
  for (const id of await readdir(rootDirectory)) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const root = childOf(rootDirectory, id);
    try {
      const handle = await open(join(root, CHECKPOINT_METADATA_FILE), "r");
      await handle.close();
      result.push({ checkpointId: id, ref: { kind: "filesystem", id, root } });
    } catch {
      // Incomplete physical content is deliberately not adopted.
    }
  }
  return result;
}

export async function deleteStorageRoot(root: string) {
  await rm(root, { recursive: true, force: true });
}

export async function deleteCheckpointRoot(root: string) {
  await makeWritable(root).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
