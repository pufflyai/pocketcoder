import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PoolProviderInput,
  type ProviderInput,
  parseTemplateManifest,
  snapshotOf,
} from "@pstdio/pocketcoder-contracts";
import type { WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import { KubernetesDriver } from "./kubernetes";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeKubectl(): Promise<{ bin: string; log: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-kubectl-test-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "calls.ndjson");
  const script = join(directory, "kubectl.ts");
  const bin = process.platform === "win32" ? join(directory, "kubectl.cmd") : script;
  await writeFile(
    script,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const input = args.includes("apply") ? await Bun.stdin.text() : "";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + "\\n");
if (args.includes("get") && args.includes("job")) console.log(JSON.stringify({ status: { active: 1 } }));
if (args.includes("get") && args.includes("jobs")) console.log(JSON.stringify({ items: [] }));
if (args.includes("version")) console.log(JSON.stringify({ serverVersion: { major: "1", minor: "33" } }));
`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    await writeFile(bin, `@${JSON.stringify(process.execPath)} ${JSON.stringify(script)} %*\r\n`);
  }
  return { bin, log };
}

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
        writableMemoryPaths: ["/tmp", "/home/onefin"],
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

describe("Kubernetes workspace driver", () => {
  test("creates an equivalent task-agnostic warm Job and Secret", async () => {
    const fake = await fakeKubectl();
    const workspace = fixtureWorkspace();
    const runtimeId = randomUUID();
    const input: PoolProviderInput = {
      pool_runtime_id: runtimeId,
      server_url: "http://pocketcoder-server.agents.svc:7080",
      enrollment_secret: "pool-only",
      template_digest: workspace.templateDigest,
      template_name: workspace.templateName,
      template_version: workspace.templateVersion,
    };
    const driver = new KubernetesDriver({ namespace: "agents", kubectlBin: fake.bin });
    await driver.createWarm({
      runtimeId,
      template: workspace.templateSnapshot,
      input,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const calls = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    const manifests = calls
      .filter((call) => call.args.includes("apply"))
      .map(
        (call) =>
          JSON.parse(call.input) as {
            kind: string;
            stringData?: Record<string, string>;
            metadata: { labels: Record<string, string> };
          },
      );
    expect(manifests.map((manifest) => manifest.kind)).toEqual(["Secret", "Job"]);
    const secretInput = manifests[0]?.stringData?.["input.json"] ?? "";
    expect(JSON.parse(secretInput)).toEqual(input);
    expect(secretInput).not.toContain("workspace_id");
    const jobLabels = manifests[1]?.metadata.labels ?? {};
    expect(jobLabels["pocketcoder.pool-runtime"]).toBe(runtimeId);
    expect(jobLabels["pocketcoder.workspace"]).toBeUndefined();
  });
  test("projects the portable launch contract into a namespaced Job", async () => {
    const fake = await fakeKubectl();
    const workspace = fixtureWorkspace();
    const input: ProviderInput = {
      workspace_id: workspace.id,
      server_url: "http://pocketcoder-server.agents.svc:7080",
      registration_secret: "one-time",
      template_digest: workspace.templateDigest,
      template_name: workspace.templateName,
      template_version: workspace.templateVersion,
      launch_mode: "create",
    };
    const driver = new KubernetesDriver({
      namespace: "agents",
      serviceAccountName: "workspace",
      kubectlBin: fake.bin,
    });
    const ref = await driver.create({
      workspace,
      input,
      mounts: [
        {
          name: "worktree",
          target: "/workspace",
          source: {
            kind: "pvc",
            claimName: "workspace-data",
            subPath: `workspaces/${workspace.id}/worktree`,
          },
        },
      ],
      secrets: [
        {
          name: "model-key",
          target: "/run/pocketcoder/secrets/model-key",
          source: {
            kind: "kubernetes-secret",
            secretName: "model",
            key: "key",
          },
        },
      ],
    });
    expect(ref.kind).toBe("kubernetes");
    const calls = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    const manifests = calls
      .filter((call) => call.args.includes("apply"))
      .map((call) => JSON.parse(call.input) as Record<string, unknown>);
    expect(manifests.map((manifest) => manifest.kind)).toEqual(["Secret", "Job"]);
    const job = manifests[1] as {
      spec: {
        template: {
          spec: {
            serviceAccountName: string;
            automountServiceAccountToken: boolean;
            securityContext: {
              fsGroup: number;
              fsGroupChangePolicy: string;
              seccompProfile: { type: string };
            };
            containers: Array<{
              env: Array<{ name: string; value: string }>;
              securityContext: Record<string, unknown>;
              volumeMounts: Array<{ mountPath: string }>;
            }>;
            volumes: Array<Record<string, unknown>>;
          };
        };
      };
    };
    expect(job.spec.template.spec.serviceAccountName).toBe("workspace");
    expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(job.spec.template.spec.securityContext).toEqual({
      fsGroup: 23_456,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(job.spec.template.spec.containers[0]?.securityContext).toMatchObject({
      runAsUser: 12_345,
      runAsGroup: 23_456,
      runAsNonRoot: true,
      allowPrivilegeEscalation: false,
    });
    expect(job.spec.template.spec.containers[0]?.env).toEqual([
      { name: "SAFE_VALUE", value: "yes" },
    ]);
    expect(
      job.spec.template.spec.containers[0]?.volumeMounts.map((mount) => mount.mountPath),
    ).toContain("/workspace");
    expect(
      job.spec.template.spec.containers[0]?.volumeMounts.map((mount) => mount.mountPath),
    ).toContain("/run/pocketcoder/secrets/model-key");
    expect(
      job.spec.template.spec.containers[0]?.volumeMounts.map((mount) => mount.mountPath),
    ).toContain("/home/onefin");
    expect(job.spec.template.spec.volumes).toHaveLength(5);
  });

  test("places NET_ADMIN and audit credentials only in a restartable native sidecar", async () => {
    const fake = await fakeKubectl();
    const workspace = fixtureWorkspace();
    workspace.templateSnapshot.spec.network = {
      mode: "restricted",
      allow: [{ domain: "github.com", ports: [443], allowPrivate: false }],
    };
    workspace.networkState = "starting";
    const input: ProviderInput = {
      workspace_id: workspace.id,
      server_url: "http://pocketcoder-server.agents.svc:7080",
      registration_secret: "one-time",
      template_digest: workspace.templateDigest,
      template_name: workspace.templateName,
      template_version: workspace.templateVersion,
      launch_mode: "create",
    };
    const driver = new KubernetesDriver({
      namespace: "agents",
      kubectlBin: fake.bin,
      egressImage: `registry.example/egress@sha256:${"e".repeat(64)}`,
      egressSigningKey: "test-signing-key",
    });
    await driver.create({ workspace, input, mounts: [], secrets: [] });
    const manifests = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string })
      .filter((call) => call.args.includes("apply"))
      .map((call) => JSON.parse(call.input) as Record<string, unknown>);
    expect(manifests.map((manifest) => manifest.kind)).toEqual(["Secret", "Secret", "Job"]);
    const providerSecret = manifests[0] as { stringData: Record<string, string> };
    expect(JSON.parse(providerSecret.stringData["input.json"] as string).server_url).toBe(
      "http://127.0.0.1:18081",
    );
    const egressSecret = manifests[1] as { stringData: Record<string, string> };
    const egress = JSON.parse(egressSecret.stringData["egress.json"] as string);
    expect(egress.control_url).toBe(input.server_url);
    expect(egress.audit_token).toStartWith("pce1.");
    const job = manifests[2] as {
      spec: {
        template: {
          spec: {
            initContainers: Array<Record<string, unknown>>;
            containers: Array<{
              securityContext: { capabilities: { add?: string[] } };
              volumeMounts: Array<{ name: string }>;
            }>;
          };
        };
      };
    };
    const sidecar = job.spec.template.spec.initContainers[0] as {
      restartPolicy: string;
      startupProbe: unknown;
      securityContext: { capabilities: { add: string[]; drop: string[] } };
      volumeMounts: Array<{ name: string }>;
    };
    expect(sidecar.restartPolicy).toBe("Always");
    expect(sidecar.startupProbe).toBeDefined();
    expect(sidecar.securityContext.capabilities).toEqual({
      drop: ["ALL"],
      add: ["NET_ADMIN", "SETUID", "SETGID"],
    });
    expect(sidecar.volumeMounts.map((mount) => mount.name)).toContain("egress-config");
    const workspaceContainer = job.spec.template.spec.containers[0];
    expect(workspaceContainer?.securityContext.capabilities.add).toBeUndefined();
    expect(workspaceContainer?.volumeMounts.map((mount) => mount.name)).not.toContain(
      "egress-config",
    );
  });
});
