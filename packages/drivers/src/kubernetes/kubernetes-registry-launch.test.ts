import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { parseTemplateManifest, snapshotOf } from "@pstdio/pocketcoder-contracts";
import type { WorkspaceLaunch, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { registryWorkspaceCommand } from "./kubernetes-registry-fixture";

export function registryLaunch(image: string): WorkspaceLaunch {
  const snapshot = snapshotOf(
    parseTemplateManifest({
      apiVersion: "pocketcoder.dev/v1alpha1",
      kind: "Template",
      metadata: { name: "private-kind" },
      spec: {
        version: "1.0.0",
        image,
        imagePullSecret: "secretRef:pull-image",
        command: registryWorkspaceCommand,
        harness: { command: registryWorkspaceCommand },
        resources: { cpu: "1", memory: "128Mi" },
      },
    }),
  );
  const id = randomUUID();
  return {
    workspace: {
      id,
      templateDigest: snapshot.digest,
      templateSnapshot: snapshot,
      deadlineAt: new Date(Date.now() + 60000),
    } as WorkspaceRow,
    input: {
      workspace_id: id,
      server_url: "http://localhost:8091",
      registration_secret: "one-use",
      template_name: snapshot.name,
      template_version: snapshot.version,
      template_digest: snapshot.digest,
      launch_mode: "create",
    },
    mounts: [],
    secrets: [],
  };
}

test("private registry qualification launches its shell harness through the supported template contract", () => {
  const launch = registryLaunch(`registry.example/workspace@sha256:${"a".repeat(64)}`);
  expect(launch.workspace.templateSnapshot.spec.harness?.command).toEqual(registryWorkspaceCommand);
  expect(launch.workspace.templateSnapshot.spec.command).toEqual(registryWorkspaceCommand);
  expect(launch.workspace.templateSnapshot.spec.imagePullSecret).toBe("secretRef:pull-image");
  expect(launch.input.template_digest).toBe(launch.workspace.templateDigest);
});
