import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { FileSecretResolver } from "./file-secrets";
import { KubernetesSecretResolver } from "./kubernetes-secrets";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function workspace(reference: string): WorkspaceRow {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "secret-fixture" },
    spec: {
      version: "1.0.0",
      image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
      harness: {
        command: ["/bin/true"],
        env: { MODEL_KEY_FILE: reference },
      },
      resources: { cpu: "1", memory: "256Mi" },
    },
  });
  return {
    templateSnapshot: snapshotOf(parsed),
    sourceDescriptor: null,
  } as WorkspaceRow;
}

function sourceWorkspace(runtimeReference: string, sourceReference: string): WorkspaceRow {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "source-secret-fixture" },
    spec: {
      version: "1.0.0",
      image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
      harness: {
        command: ["/bin/true"],
        env: { MODEL_KEY_FILE: runtimeReference },
      },
      resources: { cpu: "1", memory: "256Mi" },
      persistence: {
        mounts: [{ name: "worktree", target: "/workspace", maxBytes: 1024, maxFiles: 10 }],
      },
      source: {
        kind: "git",
        destinationMount: "worktree",
        repositories: {
          app: {
            url: "https://github.com/example/app.git",
            credential: sourceReference,
          },
        },
      },
    },
  });
  return {
    templateSnapshot: snapshotOf(parsed),
    sourceDescriptor: { kind: "git", repository: "app", revision: "main" },
    launchMode: "create",
  } as WorkspaceRow;
}

describe("deployment secret resolvers", () => {
  test("projects only bounded regular files beneath the local secret root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocketcoder-secret-test-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "model"));
    await writeFile(join(root, "model", "key"), "secret\n", { mode: 0o600 });
    const resolver = new FileSecretResolver({ root });
    const [resolved] = await resolver.resolve(workspace("secretRef:model/key"));
    expect(resolved?.target).toBe("/run/pocketcoder/secrets/model%2Fkey");
    expect(resolved?.source.kind).toBe("host-path");

    const outside = await mkdtemp(join(tmpdir(), "pocketcoder-secret-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "key"), "outside");
    await symlink(join(outside, "key"), join(root, "escape"));
    await expect(resolver.resolve(workspace("secretRef:escape"))).rejects.toThrow("escaped");
  });

  test("maps Kubernetes refs to one Secret key and rejects nested keys", async () => {
    const resolver = new KubernetesSecretResolver();
    expect(await resolver.resolve(workspace("secretRef:model/key"))).toEqual([
      {
        name: "model-key",
        target: "/run/pocketcoder/secrets/model%2Fkey",
        source: {
          kind: "kubernetes-secret",
          secretName: "model",
          key: "key",
        },
      },
    ]);
    await expect(resolver.resolve(workspace("secretRef:model/path/key"))).rejects.toThrow(
      "secretRef:<secret-name>/<key>",
    );
  });

  test("keeps repository credentials out of runtime mounts and resolves their values", async () => {
    const root = await mkdtemp(join(tmpdir(), "pocketcoder-source-secret-test-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "model"));
    await mkdir(join(root, "git"));
    await writeFile(join(root, "model", "key"), "model-key");
    await writeFile(join(root, "git", "token"), "short-lived-git-token");
    const resolver = new FileSecretResolver({ root });
    const input = sourceWorkspace("secretRef:model/key", "secretRef:git/token");

    expect(await resolver.resolve(input)).toEqual([
      expect.objectContaining({ target: "/run/pocketcoder/secrets/model%2Fkey" }),
    ]);
    expect(await resolver.resolveSourceCredential(input)).toBe("short-lived-git-token");
    input.launchMode = "restore";
    expect(await resolver.resolveSourceCredential(input)).toBeNull();
  });

  test("reads a repository credential from Kubernetes without projecting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocketcoder-kubernetes-secret-test-"));
    temporaryDirectories.push(directory);
    const kubectlBin = join(directory, "kubectl");
    await writeFile(
      kubectlBin,
      `#!/bin/sh\nprintf '%s' '{"data":{"token":"${Buffer.from("short-lived-git-token").toString("base64")}"}}'\n`,
    );
    await chmod(kubectlBin, 0o700);
    const resolver = new KubernetesSecretResolver({ namespace: "agents", kubectlBin });
    const input = sourceWorkspace("secretRef:model/key", "secretRef:git/token");

    expect(await resolver.resolve(input)).toEqual([
      expect.objectContaining({ target: "/run/pocketcoder/secrets/model%2Fkey" }),
    ]);
    expect(await resolver.resolveSourceCredential(input)).toBe("short-lived-git-token");
    input.launchMode = "restore";
    expect(await resolver.resolveSourceCredential(input)).toBeNull();
  });
});
