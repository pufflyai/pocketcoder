import { describe, expect, test } from "bun:test";
import type { WarmRuntimeLaunch, WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";
import { warmJobManifest, workspaceJobManifest } from "./kubernetes-manifests";

function templateSpec(ephemeralStorage?: string) {
  return {
    image: "registry.example/workspace@sha256:fixture",
    command: ["/bin/sleep", "3600"],
    env: {},
    resources: {
      cpu: "1",
      memory: "512Mi",
      ...(ephemeralStorage ? { ephemeralStorage } : {}),
    },
    security: {
      uid: 10_001,
      gid: 10_001,
      writableMemoryPaths: ["/tmp"],
      readOnlyRoot: true,
      allowPrivilegeEscalation: false,
      dropCapabilities: ["ALL"],
      seccomp: "RuntimeDefault",
    },
    network: { mode: "unrestricted" },
  };
}

function workspaceLaunch(ephemeralStorage?: string) {
  return {
    workspace: {
      id: "workspace-id",
      templateDigest: "sha256:template",
      templateSnapshot: { spec: templateSpec(ephemeralStorage) },
    },
    mounts: [],
    secrets: [],
  } as unknown as WorkspaceLaunch;
}

function warmLaunch(ephemeralStorage?: string) {
  return {
    runtimeId: "runtime-id",
    template: { digest: "sha256:template", spec: templateSpec(ephemeralStorage) },
  } as unknown as WarmRuntimeLaunch;
}

const options = {
  imagePullPolicy: "IfNotPresent" as const,
  nodeSelector: { "onefin.com/workload": "agent-workspace" },
  tolerations: [
    {
      key: "onefin.com/workload",
      operator: "Equal" as const,
      value: "agent-workspace",
      effect: "NoSchedule" as const,
    },
  ],
};

function podSpec(
  manifest: ReturnType<typeof workspaceJobManifest> | ReturnType<typeof warmJobManifest>,
) {
  return manifest.spec.template.spec;
}

describe("Kubernetes Job manifests", () => {
  test("adds scheduling fields to workspace and warm Jobs", () => {
    const manifests = [
      workspaceJobManifest(workspaceLaunch(), "workspace", "input", "egress", options),
      warmJobManifest(warmLaunch(), "warm", "input", "egress", options),
    ];

    for (const manifest of manifests) {
      expect(podSpec(manifest).nodeSelector).toEqual(options.nodeSelector);
      expect(podSpec(manifest).tolerations).toEqual(options.tolerations);
    }
  });

  test("omits scheduling fields from workspace and warm Jobs by default", () => {
    const defaults = { imagePullPolicy: "IfNotPresent" as const };
    const manifests = [
      workspaceJobManifest(workspaceLaunch(), "workspace", "input", "egress", defaults),
      warmJobManifest(warmLaunch(), "warm", "input", "egress", defaults),
    ];

    for (const manifest of manifests) {
      expect("nodeSelector" in podSpec(manifest)).toBe(false);
      expect("tolerations" in podSpec(manifest)).toBe(false);
    }
  });

  test("maps ephemeral storage for workspace and warm Jobs", () => {
    const manifests = [
      workspaceJobManifest(workspaceLaunch("10Gi"), "workspace", "input", "egress", options),
      warmJobManifest(warmLaunch("10Gi"), "warm", "input", "egress", options),
    ];
    const expected = {
      requests: { cpu: "1", memory: "512Mi", "ephemeral-storage": "10Gi" },
      limits: { cpu: "1", memory: "512Mi", "ephemeral-storage": "10Gi" },
    };

    for (const manifest of manifests) {
      expect(podSpec(manifest).containers[0]?.resources).toEqual(expected);
    }
  });
});
