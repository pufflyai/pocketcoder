import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { checkpointTransferOptions } from "./checkpoint-transfer-config";

test("Docker transfer uses the configured checkpoint custody and unchanged retention limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-transfer-config-"));
  try {
    const config = loadConfig({
      POCKETCODER_STORAGE_BACKEND: "filesystem",
      POCKETCODER_WORKSPACE_DATA_DIR: join(root, "live"),
      POCKETCODER_CHECKPOINT_DIR: join(root, "archives"),
    });
    const options = checkpointTransferOptions(config);
    expect(options?.directory).toBe(await realpath(join(root, "archives")));
    expect(options?.retentionLimits).toEqual(config.persistenceLimits);
    expect(options?.limits.maxArchiveBytes).toBe(500 * 1024 ** 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
