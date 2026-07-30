import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
	const bin = join(directory, "kubectl");
	await writeFile(
		bin,
		`#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const input = args.includes("apply") ? await Bun.stdin.text() : "";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + "\\n");
if (args.includes("get") && args.includes("job")) console.log(JSON.stringify({ status: { active: 1 } }));
if (args.includes("get") && args.includes("jobs")) console.log(JSON.stringify({ items: [] }));
`,
		{ mode: 0o755 },
	);
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
			security: { writableMemoryPaths: ["/tmp"] },
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
		terminalIntent: null,
		launchInput: null,
		providerKind: null,
		providerRef: null,
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
						containers: Array<{
							env: Array<{ name: string; value: string }>;
							volumeMounts: Array<{ mountPath: string }>;
						}>;
						volumes: Array<Record<string, unknown>>;
					};
				};
			};
		};
		expect(job.spec.template.spec.serviceAccountName).toBe("workspace");
		expect(job.spec.template.spec.automountServiceAccountToken).toBe(false);
		expect(job.spec.template.spec.containers[0]?.env).toEqual([
			{ name: "SAFE_VALUE", value: "yes" },
		]);
		expect(
			job.spec.template.spec.containers[0]?.volumeMounts.map((mount) => mount.mountPath),
		).toContain("/workspace");
		expect(
			job.spec.template.spec.containers[0]?.volumeMounts.map((mount) => mount.mountPath),
		).toContain("/run/pocketcoder/secrets/model-key");
		expect(job.spec.template.spec.volumes).toHaveLength(4);
	});
});
