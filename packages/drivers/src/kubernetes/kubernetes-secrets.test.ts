import { expect, test } from "bun:test";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesSecretResolver } from "./kubernetes-secrets";

const pullReference = "secretRef:pocketcoder-ws-12345678-1234-1234-1234-123456789abc-registry/.dockerconfigjson";

function workspace(): WorkspaceRow {
  const templateSnapshot = snapshotOf(
    parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "registry-isolation" },
      spec: {
        version: "1.0.0",
        image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
        harness: { command: ["true"], env: { MODEL_KEY_FILE: "secretRef:model/key" } },
        persistence: { mounts: [{ name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 }] },
        source: {
          kind: "git",
          destinationMount: "worktree",
          repositories: { app: { url: "https://github.com/example/app.git", credential: pullReference } },
        },
        resources: { cpu: "1", memory: "128Mi" },
      },
    }),
  );
  return {
    templateSnapshot,
    sourceDescriptor: { kind: "git", repository: "app", revision: "main" },
    launchMode: "create",
  } as WorkspaceRow;
}

test("a runtime reference cannot project another workspace's controller pull Secret", async () => {
  const input = workspace();
  input.templateSnapshot.spec.env = { REGISTRY_CONFIG: pullReference };
  await expect(new KubernetesSecretResolver().resolve(input)).rejects.toThrow(
    "Controller registry Secrets cannot be read by workspaces",
  );
});

test("a source reference cannot read another workspace's controller pull Secret", async () => {
  await expect(new KubernetesSecretResolver().resolveSourceCredential(workspace())).rejects.toThrow(
    "Controller registry Secrets cannot be read by workspaces",
  );
});
