import { expect, test } from "bun:test";
import { createStorageDriver } from "../lifecycle/lifecycle-resources";
import { loadConfig } from "./config";

const storage = {
  root: "/shared",
  claimName: "shared",
  volumeName: "qualified-pv",
  storageClassName: "qualified-nfs",
  profile: "shared-writer-readonly/v1" as const,
  networkPolicyName: "storage-isolation",
  storageCidrs: ["192.0.2.10/32"],
  maxBytes: 16 * 1024 ** 2,
  maxFiles: 64,
};
const environment = {
  POCKETCODER_DRIVER: "kubernetes",
  POCKETCODER_STORAGE_BACKEND: "kubernetes-shared",
  POCKETCODER_CHECKPOINT_DIR: "/private/checkpoints",
  POCKETCODER_KUBERNETES_SHARED_STORAGE: JSON.stringify(storage),
};
test("constructs only an explicitly configured shared writer profile", () => {
  const config = loadConfig(environment);
  expect(config.kubernetesSharedStorage).toEqual({ ...storage, checkpointRoot: "/private/checkpoints" });
  expect(createStorageDriver(config)?.kind).toBe("kubernetes-shared");
  expect(() => loadConfig({ ...environment, POCKETCODER_KUBERNETES_SHARED_STORAGE: undefined })).toThrow(
    "SHARED_STORAGE",
  );
  expect(() => loadConfig({ ...environment, POCKETCODER_DRIVER: "docker" })).toThrow("POCKETCODER_DRIVER");
  for (const changed of [
    { profile: "read-write-once" },
    { maxBytes: 0 },
    { claimName: "../other" },
    { storageCidrs: ["999.0.2.1/32"] },
  ]) {
    expect(() =>
      createStorageDriver(
        loadConfig({
          ...environment,
          POCKETCODER_KUBERNETES_SHARED_STORAGE: JSON.stringify({ ...storage, ...changed }),
        }),
      ),
    ).toThrow();
  }
});
