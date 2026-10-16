import { mkdirSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import type { InputStorageOptions } from "../attachments/input-storage";
import type { ServerConfig } from "../config/config";

export function inputStorageOptions(config: ServerConfig): InputStorageOptions | undefined {
  const input = config.inputStorage;
  if (!input) return;
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  const root = realpathSync(input.root);
  const workloadRoots = [
    config.workspaceDataDir,
    config.inputDir,
    input.projection?.root,
    config.kubernetesSharedStorage?.root,
  ]
    .filter((p): p is string => !!p)
    .map((path) => {
      mkdirSync(path, { recursive: true });
      return realpathSync(path);
    });
  const driver = new FilesystemInputStorage(root, workloadRoots);
  return {
    driver,
    limits: input.limits,
    capacity: async () => {
      const disk = await statfs(root);
      return {
        workspace: { bytes: input.limits.stagedBytes, files: input.limits.files },
        principal: input.principal,
        instance: input.instance,
        freeDisk: {
          bytes: disk.bavail * disk.bsize,
          files: disk.ffree,
          headroomBytes: input.headroom.bytes,
          headroomFiles: input.headroom.files,
        },
      };
    },
  };
}

export function dockerInputProjectionOptions(config: ServerConfig) {
  const input = config.inputStorage;
  if (!input?.projection) return;
  const storage = new FilesystemInputStorage(input.root, [
    input.projection.root,
    ...[config.workspaceDataDir, config.inputDir].filter((path): path is string => !!path),
  ]);
  return { ...input.projection, storage, privateRoots: [input.root] };
}
