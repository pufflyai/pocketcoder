import { describe, expect, test } from "bun:test";
import { configSummary, loadConfig } from "./config";

describe("portable persistence configuration", () => {
  test("parses operator warm pool configuration with safe defaults", () => {
    const config = loadConfig({
      POCKETCODER_STORE: "memory",
      POCKETCODER_WARM_POOLS: JSON.stringify([{ template: "fixture-echo" }]),
    });
    expect(config.warmPools).toEqual([
      {
        template: "fixture-echo",
        minReady: 1,
        maxWarmAgeMs: 15 * 60_000,
        missPolicy: "cold",
        waitTimeoutMs: 5000,
      },
    ]);
  });
  test("configures host-local filesystem storage explicitly", () => {
    const config = loadConfig({
      POCKETCODER_STORE: "memory",
      POCKETCODER_DRIVER: "docker",
      POCKETCODER_STORAGE_BACKEND: "filesystem",
      POCKETCODER_WORKSPACE_DATA_DIR: "/var/lib/pocketcoder/workspaces",
      POCKETCODER_CHECKPOINT_DIR: "/var/lib/pocketcoder/checkpoints",
      POCKETCODER_SECRET_PROVIDER: "file",
      POCKETCODER_SECRET_ROOT: "/etc/pocketcoder/secrets",
      POCKETCODER_MAX_RETAINED_BYTES: "2Gi",
    });
    expect(config.driverKind).toBe("docker");
    expect(config.storageBackend).toBe("filesystem");
    expect(config.secretProvider).toBe("file");
    expect(config.persistenceLimits.maxRetainedBytes).toBe(2 * 1024 ** 3);
  });

  test("configures Kubernetes Jobs, PVC storage, and Secret projection", () => {
    const config = loadConfig({
      POCKETCODER_STORE: "memory",
      POCKETCODER_DRIVER: "kubernetes",
      POCKETCODER_KUBERNETES_NAMESPACE: "agents",
      POCKETCODER_KUBERNETES_SERVICE_ACCOUNT: "workspace",
      POCKETCODER_KUBERNETES_NODE_SELECTOR: '{"dedicated":"workspace"}',
      POCKETCODER_KUBERNETES_TOLERATIONS: '[{"operator":"Exists","effect":"NoSchedule"}]',
      POCKETCODER_STORAGE_BACKEND: "kubernetes-pvc",
      POCKETCODER_KUBERNETES_WORKSPACE_CLAIM: "workspace-data",
      POCKETCODER_WORKSPACE_DATA_DIR: "/data/workspaces",
      POCKETCODER_CHECKPOINT_DIR: "/data/checkpoints",
      POCKETCODER_SECRET_PROVIDER: "kubernetes",
    });
    expect(config.driverKind).toBe("kubernetes");
    expect(config.storageBackend).toBe("kubernetes-pvc");
    expect(config.secretProvider).toBe("kubernetes");
    expect(config.kubernetesNodeSelector).toEqual({ dedicated: "workspace" });
    expect(config.kubernetesTolerations).toEqual([{ operator: "Exists", effect: "NoSchedule" }]);
    expect(config.workspaceServerUrl).toBe("http://pocketcoder-server.agents.svc:7080");
  });

  test("fails closed when a persistence backend is only partially configured", () => {
    expect(() =>
      loadConfig({
        POCKETCODER_STORE: "memory",
        POCKETCODER_STORAGE_BACKEND: "filesystem",
        POCKETCODER_WORKSPACE_DATA_DIR: "/data/workspaces",
      }),
    ).toThrow("POCKETCODER_CHECKPOINT_DIR");
    expect(() =>
      loadConfig({
        POCKETCODER_STORE: "memory",
        POCKETCODER_STORAGE_BACKEND: "kubernetes-pvc",
        POCKETCODER_WORKSPACE_DATA_DIR: "/data/workspaces",
        POCKETCODER_CHECKPOINT_DIR: "/data/checkpoints",
      }),
    ).toThrow("POCKETCODER_KUBERNETES_WORKSPACE_CLAIM");
  });

  test("rejects unknown explicit backend values instead of selecting fallbacks", () => {
    expect(() =>
      loadConfig({ POCKETCODER_STORE: "memroy", POCKETCODER_DATABASE_URL: "postgres://unused" }),
    ).toThrow("POCKETCODER_STORE");
    expect(() => loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_DRIVER: "dokcer" })).toThrow(
      "POCKETCODER_DRIVER",
    );
    expect(() =>
      loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_STORAGE_BACKEND: "filesytem" }),
    ).toThrow("POCKETCODER_STORAGE_BACKEND");
    expect(() =>
      loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_SECRET_PROVIDER: "kubernets" }),
    ).toThrow("POCKETCODER_SECRET_PROVIDER");
  });

  test("rejects ports outside the TCP range", () => {
    expect(() => loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_PORT: "65536" })).toThrow(
      "POCKETCODER_PORT",
    );
  });

  test("rejects driver, storage, and secret combinations that cannot be mounted", () => {
    expect(() =>
      loadConfig({
        POCKETCODER_STORE: "memory",
        POCKETCODER_DRIVER: "docker",
        POCKETCODER_STORAGE_BACKEND: "kubernetes-pvc",
        POCKETCODER_WORKSPACE_DATA_DIR: "/data/workspaces",
        POCKETCODER_CHECKPOINT_DIR: "/data/checkpoints",
        POCKETCODER_KUBERNETES_WORKSPACE_CLAIM: "workspace-data",
      }),
    ).toThrow("POCKETCODER_DRIVER");
    expect(() =>
      loadConfig({
        POCKETCODER_STORE: "memory",
        POCKETCODER_DRIVER: "kubernetes",
        POCKETCODER_STORAGE_BACKEND: "filesystem",
        POCKETCODER_WORKSPACE_DATA_DIR: "/data/workspaces",
        POCKETCODER_CHECKPOINT_DIR: "/data/checkpoints",
      }),
    ).toThrow("POCKETCODER_STORAGE_BACKEND");
  });

  test("accepts only digest-pinned egress runtime images", () => {
    expect(
      loadConfig({
        POCKETCODER_STORE: "memory",
        POCKETCODER_EGRESS_IMAGE: `registry.example/egress@sha256:${"a".repeat(64)}`,
      }).egressImage,
    ).toContain("@sha256:");
    expect(() =>
      loadConfig({
        POCKETCODER_STORE: "memory",
        POCKETCODER_EGRESS_IMAGE: "registry.example/egress:latest",
      }),
    ).toThrow("immutable sha256 digest");
  });

  test("rejects malformed service URLs", () => {
    expect(() =>
      loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_WORKSPACE_SERVER_URL: "localhost" }),
    ).toThrow("POCKETCODER_WORKSPACE_SERVER_URL");
    expect(() =>
      loadConfig({ POCKETCODER_STORE: "memory", POCKETCODER_EVENT_SINK_URL: "file:///tmp/sink" }),
    ).toThrow("POCKETCODER_EVENT_SINK_URL");
  });

  test("summarizes resolved configuration without secrets or URLs", () => {
    const config = loadConfig({
      POCKETCODER_STORE: "memory",
      POCKETCODER_AUTH_PEPPER: "secret-pepper",
      POCKETCODER_EVENT_SINK_URL: "https://token@example.test/events",
    });
    const serialized = JSON.stringify(configSummary(config));

    expect(serialized).not.toContain("secret-pepper");
    expect(serialized).not.toContain("token@example");
    expect(serialized).toContain('"store":"memory"');
  });
});
