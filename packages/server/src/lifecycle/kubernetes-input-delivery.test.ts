import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestOf } from "@pstdio/pocketcoder-contracts";
import { FilesystemInputStorage } from "@pstdio/pocketcoder-drivers";
import type { InputProjectionRef } from "@pstdio/pocketcoder-runtime-core";
import { loadConfig } from "../config/config";
import { createStorageDriver, createWorkspaceDriver } from "./lifecycle-resources";

function kubernetesConfig(root: string) {
  return loadConfig({
    POCKETCODER_DRIVER: "kubernetes",
    POCKETCODER_STORAGE_BACKEND: "kubernetes-shared",
    POCKETCODER_CHECKPOINT_DIR: join(root, "checkpoints"),
    POCKETCODER_KUBERNETES_SHARED_STORAGE: JSON.stringify({
      root: join(root, "shared"),
      claimName: "shared",
      volumeName: "qualified-pv",
      storageClassName: "qualified-nfs",
      profile: "shared-writer-readonly/v1",
      networkPolicyName: "storage-isolation",
      storageCidrs: ["192.0.2.10/32"],
      maxBytes: 16_777_216,
      maxFiles: 64,
    }),
    POCKETCODER_INPUT_STORAGE: JSON.stringify({
      root: join(root, "canonical"),
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
    }),
  });
}

async function uploadedProjection(canonicalRoot: string, workspaceId: string): Promise<InputProjectionRef> {
  const bytes = Buffer.from("quarterly report");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const reference = {
    workspaceId,
    fileId: randomUUID(),
    objectVersion: digest,
    digest,
    name: "report.txt",
    mediaType: "text/plain",
    sizeBytes: bytes.length,
    visibility: "ready" as const,
  };
  const backing = { workspaceId, fileId: reference.fileId, versionId: randomUUID() };
  const writer = await new FilesystemInputStorage(canonicalRoot, []).create(backing);
  await writer.write(bytes);
  await writer.publish();
  const contents = { workspaceId, incarnationId: "job-uid", objects: [reference] };
  return {
    kind: "immutable-inputs/v1",
    manifestId: randomUUID(),
    manifest: { ...contents, digest: digestOf(contents) },
    objects: [{ backing, reference }],
  };
}

test("a Kubernetes controller with shared storage publishes uploaded files until the execution releases them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pc-k8s-inputs-"));
  try {
    const config = kubernetesConfig(root);
    const storage = createStorageDriver(config);
    const driver = createWorkspaceDriver(
      config,
      undefined,
      storage?.kind === "kubernetes-shared" ? storage : undefined,
    );
    const workspaceId = randomUUID();
    const projection = await uploadedProjection(join(root, "canonical"), workspaceId);
    const ref = { kind: "kubernetes", id: "pocketcoder-ws", workspaceId };
    const fileId = projection.objects[0]?.reference.fileId;
    const published = join(root, "shared", "inputs", workspaceId, "published", projection.manifestId);

    expect(await driver.publishInputs?.(ref, projection)).toEqual({
      manifestId: projection.manifestId,
      digest: projection.manifest.digest,
      directory: `/run/pocketcoder/inputs/${projection.manifestId}`,
    });
    expect(await readFile(join(published, `${fileId}`), "utf8")).toBe("quarterly report");

    await driver.releaseInputProjection?.(ref, projection.manifestId);
    expect(await readFile(join(published, `${fileId}`)).catch((error) => error.code)).toBe("ENOENT");
    await expect(driver.publishInputs?.(ref, projection)).rejects.toThrow("released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
