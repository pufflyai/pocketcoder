import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { RuntimeMountRef, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { workspaceJobManifest } from "./kubernetes-manifests";

function render(mounts: RuntimeMountRef[]) {
  const workspace = fixtureWorkspace();
  workspace.templateSnapshot.spec.resources.ephemeralStorage = "128Mi";
  return workspaceJobManifest(
    {
      workspace,
      mounts,
      secrets: [],
      input: {
        workspace_id: workspace.id,
        server_url: "http://server:7080",
        registration_secret: "one-time",
        template_digest: workspace.templateDigest,
        template_name: workspace.templateName,
        template_version: workspace.templateVersion,
        launch_mode: "create",
      },
    },
    "workspace-job",
    "input-secret",
    "egress-secret",
    { imagePullPolicy: "IfNotPresent" },
  ).spec.template.spec;
}

test("source mounts use bounded emptyDir and full ephemeral storage requests and limits", () => {
  const pod = render([{ name: "source", target: "/worktree", source: { kind: "empty-dir", maxBytes: 4 * 1024 ** 2 } }]);
  expect(pod.volumes).toContainEqual({ name: "persistent-0", emptyDir: { sizeLimit: "4194304" } });
  expect(pod.containers[0]?.resources).toMatchObject({
    requests: { "ephemeral-storage": "128Mi" },
    limits: { "ephemeral-storage": "128Mi" },
  });
  expect(() =>
    render([{ name: "source", target: "/worktree", source: { kind: "empty-dir", maxBytes: 128 * 1024 ** 2 } }]),
  ).toThrow("full ephemeral-storage");
});

test("renders a workspace without persistent mounts", () => {
  const pod = render([]);
  expect(pod.volumes.some((volume) => volume.name.startsWith("persistent-"))).toBe(false);
  expect(pod.containers[0]?.volumeMounts.some((mount) => mount.name.startsWith("persistent-"))).toBe(false);
});

function fixtureWorkspace(): WorkspaceRow {
  const parsed = parseTemplateManifest({
    apiVersion: "pocketcoder.dev/v1alpha1",
    kind: "Template",
    metadata: { name: "kubernetes-fixture" },
    spec: {
      version: "1.0.0",
      image: `registry.example/workspace@sha256:${"a".repeat(64)}`,
      harness: { command: ["/bin/sleep", "3600"] },
      env: { SAFE_VALUE: "yes", TOKEN: "secretRef:model/key" },
      resources: { cpu: "1", memory: "512Mi" },
      security: {
        uid: 12_345,
        gid: 23_456,
        writableMemoryPaths: ["/tmp"],
      },
      persistence: {
        mounts: [
          {
            name: "worktree",
            target: "/workspace",
            maxBytes: 1024,
            maxFiles: 10,
          },
        ],
      },
    },
  });
  const now = new Date();
  const id = randomUUID();
  return {
    id,
    principalId: randomUUID(),
    externalId: "kubernetes-fixture",
    idempotencyKey: "kubernetes-fixture",
    requestDigest: "sha256:request",
    templateId: randomUUID(),
    templateName: parsed.manifest.metadata.name,
    templateVersion: parsed.manifest.spec.version,
    templateDigest: parsed.digest,
    templateSnapshot: snapshotOf(parsed),
    state: "provisioning",
    reasonCode: null,
    agentState: "unknown",
    networkState: "disabled",
    networkEventSeq: 0,
    changeSeq: 1,
    failureLogTail: null,
    failureLogTailTruncated: false,
    failureLastLogSeq: null,
    terminalIntent: null,
    launchInput: null,
    providerKind: null,
    providerRef: null,
    provisioningMode: null,
    registrationDigest: null,
    registrationExpiresAt: null,
    reconnectDigest: null,
    connectionEpoch: 0,
    connectedAt: null,
    disconnectedAt: null,
    readyAt: null,
    lastActivityAt: null,
    launchAttempts: 1,
    health: {},
    metadata: {},
    deadlineAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
    purgeRequestedAt: null,
    originWorkspaceId: null,
    restoredFromCheckpointId: null,
    sourceDescriptor: null,
    resolvedSource: null,
    persistenceCapability: "filesystem_only",
    latestCheckpointId: null,
    launchMode: "create",
    outputs: {},
  };
}

test("budgets disposable mounts plus writable-layer and log headroom", () => {
  expect(() =>
    render([{ name: "work", target: "/work", source: { kind: "empty-dir", maxBytes: 128 * 1024 ** 2 } }]),
  ).toThrow("full ephemeral-storage");
});

test("initializes emptyDir roots without inherited setgid before the workspace starts", () => {
  const pod = render([{ name: "work", target: "/work", source: { kind: "empty-dir", maxBytes: 1024 } }]);
  expect(pod.initContainers?.[0]).toMatchObject({
    name: "pocketcoder-storage",
    command: [
      "pocketcoder-supervisor",
      "prepare-storage",
      JSON.stringify({ uid: 12345, gid: 23456, targets: ["/work"] }),
    ],
    securityContext: { runAsUser: 0, capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] } },
    volumeMounts: [{ name: "persistent-0", mountPath: "/work" }],
  });
});
