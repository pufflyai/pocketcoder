import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("portable persistence configuration", () => {
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
			POCKETCODER_STORAGE_BACKEND: "kubernetes-pvc",
			POCKETCODER_KUBERNETES_WORKSPACE_CLAIM: "workspace-data",
			POCKETCODER_WORKSPACE_DATA_DIR: "/data/workspaces",
			POCKETCODER_CHECKPOINT_DIR: "/data/checkpoints",
			POCKETCODER_SECRET_PROVIDER: "kubernetes",
		});
		expect(config.driverKind).toBe("kubernetes");
		expect(config.storageBackend).toBe("kubernetes-pvc");
		expect(config.secretProvider).toBe("kubernetes");
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
});
