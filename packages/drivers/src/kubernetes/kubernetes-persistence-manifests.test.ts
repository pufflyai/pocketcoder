import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { RuntimeMountRef, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { workspaceJobManifest } from "./kubernetes-manifests";
import { KubernetesPvcStorageDriver } from "./kubernetes-storage";

function render(mounts: RuntimeMountRef[]) {
  const workspace = fixtureWorkspace();
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

test("shares a PVC volume while preserving each directory and mount permission", () => {
  const pod = render([
    {
      name: "home",
      target: "/home/onefin",
      source: { kind: "pvc", claimName: "workspace-data", subPath: "workspaces/one/home" },
    },
    {
      name: "local",
      target: "/local",
      source: { kind: "host-path", path: "/srv/local" },
    },
    {
      name: "state",
      target: "/var/onefin/state",
      readOnly: true,
      source: { kind: "pvc", claimName: "workspace-data", subPath: "workspaces/one/state" },
    },
    {
      name: "reference",
      target: "/reference",
      readOnly: true,
      source: { kind: "pvc", claimName: "reference-data" },
    },
  ]);
  expect(pod.volumes.filter((volume) => "persistentVolumeClaim" in volume)).toEqual([
    { name: "persistent-0", persistentVolumeClaim: { claimName: "workspace-data" } },
    { name: "persistent-3", persistentVolumeClaim: { claimName: "reference-data" } },
  ]);
  expect(pod.volumes.filter((volume) => "hostPath" in volume)).toEqual([
    { name: "persistent-1", hostPath: { path: "/srv/local", type: "Directory" } },
  ]);
  const expectedMounts = [
    {
      name: "persistent-0",
      mountPath: "/home/onefin",
      subPath: "workspaces/one/home",
      readOnly: false,
    },
    { name: "persistent-1", mountPath: "/local", readOnly: false },
    {
      name: "persistent-0",
      mountPath: "/var/onefin/state",
      subPath: "workspaces/one/state",
      readOnly: true,
    },
    { name: "persistent-3", mountPath: "/reference", readOnly: true },
  ];
  expect(pod.containers[0]?.volumeMounts.filter((mount) => mount.name.startsWith("persistent-"))).toEqual(
    expectedMounts,
  );
  const names = pod.volumes.map((volume) => volume.name);
  expect(new Set(names).size).toBe(names.length);
  for (const mount of pod.containers[0]?.volumeMounts ?? []) {
    expect(names).toContain(mount.name);
  }
});

test("renders a workspace without persistent mounts", () => {
  const pod = render([]);
  expect(pod.volumes.some((volume) => volume.name.startsWith("persistent-"))).toBe(false);
  expect(pod.containers[0]?.volumeMounts.some((mount) => mount.name.startsWith("persistent-"))).toBe(false);
});

test("keeps storage allocations in separate subpaths when sharing the claim", async () => {
  const storage = new KubernetesPvcStorageDriver({
    workspaceRoot: join(tmpdir(), "manifest-workspaces"),
    checkpointRoot: join(tmpdir(), "manifest-checkpoints"),
    workspaceClaimName: "workspace-data",
  });
  const mounts = [
    { name: "home", target: "/home/onefin", maxBytes: 1024, maxFiles: 10 },
    { name: "state", target: "/var/onefin/state", maxBytes: 1024, maxFiles: 10 },
  ];
  for (const id of ["first-restore", "second-restore"]) {
    const pod = render(await storage.runtimeMounts({ kind: "filesystem", id }, mounts));
    expect(pod.volumes.filter((volume) => "persistentVolumeClaim" in volume)).toEqual([
      { name: "persistent-0", persistentVolumeClaim: { claimName: "workspace-data" } },
    ]);
    const expectedMounts = [
      {
        name: "persistent-0",
        mountPath: "/home/onefin",
        subPath: `workspaces/${id}/home`,
        readOnly: false,
      },
      {
        name: "persistent-0",
        mountPath: "/var/onefin/state",
        subPath: `workspaces/${id}/state`,
        readOnly: false,
      },
    ];
    expect(pod.containers[0]?.volumeMounts.filter((mount) => mount.name === "persistent-0")).toEqual(expectedMounts);
  }
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
