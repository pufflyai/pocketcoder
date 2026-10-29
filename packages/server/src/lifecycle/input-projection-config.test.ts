import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { inputStorageConfig } from "../config/input-storage-config";
import { createWorkspaceDriver } from "./lifecycle-resources";

test("requires a pinned daemon-host probe and disjoint storage roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc128-config-"));
  try {
    const value = {
      root: join(root, "canonical"),
      projection: {
        root: join(root, "projection"),
        probeImage: `fixture@sha256:${"a".repeat(64)}`,
        capacity: { bytes: 8_388_608, files: 64 },
      },
      limits: {
        fileBytes: 1_048_576,
        stagedBytes: 8_388_608,
        files: 16,
        transfers: 2,
        transferMs: 30_000,
        retentionMs: 600_000,
      },
      principal: { bytes: 16_777_216, files: 32 },
      instance: { bytes: 33_554_432, files: 64 },
      headroom: { bytes: 1, files: 1 },
    };
    expect(inputStorageConfig(JSON.stringify(value))?.projection).toEqual(value.projection);
    expect(() =>
      inputStorageConfig(JSON.stringify({ ...value, projection: { ...value.projection, probeImage: "mutable:tag" } })),
    ).toThrow();
    const config = loadConfig({
      POCKETCODER_INPUT_STORAGE: JSON.stringify(value),
      POCKETCODER_INPUT_DIR: join(root, "launch"),
    });
    expect(createWorkspaceDriver(config).kind).toBe("docker");
    expect(() => createWorkspaceDriver({ ...config, driverKind: "kubernetes" })).toThrow("Docker");
    value.projection.root = value.root;
    expect(() => createWorkspaceDriver({ ...config, inputStorage: inputStorageConfig(JSON.stringify(value)) })).toThrow(
      "overlap",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
