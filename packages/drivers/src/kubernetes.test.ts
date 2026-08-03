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
		await driver.createWarm({ runtimeId, template: workspace.templateSnapshot, input });
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
							runAsUser: number;
							runAsGroup: number;
							runAsNonRoot: boolean;
							fsGroup: number;
							fsGroupChangePolicy: string;
							seccompProfile: { type: string };
						};
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
		expect(job.spec.template.spec.securityContext).toEqual({
			runAsUser: 12_345,
			runAsGroup: 23_456,
			runAsNonRoot: true,
			fsGroup: 23_456,
			fsGroupChangePolicy: "OnRootMismatch",
			seccompProfile: { type: "RuntimeDefault" },
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
});

describe.skipIf(process.env.POCKETCODER_KUBERNETES_CONFORMANCE !== "1")(
	"Kubernetes writable-memory conformance",
	() => {
		test("makes a memory-backed emptyDir writable through fsGroup", async () => {
			const namespace = process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
			const image = process.env.POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE ?? "busybox:1.36";
			const name = `pocketcoder-memory-${randomUUID().slice(0, 8)}`;
			const manifest = {
				apiVersion: "v1",
				kind: "Pod",
				metadata: { name, namespace },
				spec: {
					restartPolicy: "Never",
					securityContext: {
						runAsUser: 10_001,
						runAsGroup: 10_001,
						runAsNonRoot: true,
						fsGroup: 10_001,
						fsGroupChangePolicy: "OnRootMismatch",
						seccompProfile: { type: "RuntimeDefault" },
					},
					containers: [
						{
							name: "probe",
							image,
							command: [
								"sh",
								"-eu",
								"-c",
								'probe=/home/onefin/.pocketcoder-probe; printf ok > "$probe"; test "$(cat "$probe")" = ok; rm "$probe"; stat -c "%a %u %g" /home/onefin',
							],
							volumeMounts: [{ name: "memory", mountPath: "/home/onefin" }],
						},
					],
					volumes: [{ name: "memory", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } }],
				},
			};
			const apply = Bun.spawn(["kubectl", "-n", namespace, "apply", "-f", "-"], {
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			apply.stdin.write(JSON.stringify(manifest));
			apply.stdin.end();
			const [applyError, applyCode] = await Promise.all([
				new Response(apply.stderr).text(),
				apply.exited,
			]);
			expect(applyCode, applyError).toBe(0);
			try {
				const wait = Bun.spawn(
					[
						"kubectl",
						"-n",
						namespace,
						"wait",
						`pod/${name}`,
						"--for=jsonpath={.status.phase}=Succeeded",
						"--timeout=90s",
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const [waitError, waitCode] = await Promise.all([
					new Response(wait.stderr).text(),
					wait.exited,
				]);
				expect(waitCode, waitError).toBe(0);
				const logs = Bun.spawnSync(["kubectl", "-n", namespace, "logs", name]);
				expect(logs.exitCode, logs.stderr.toString()).toBe(0);
				expect(logs.stdout.toString().trim()).toMatch(/^\d{3,4} \d+ 10001$/);
			} finally {
				Bun.spawnSync([
					"kubectl",
					"-n",
					namespace,
					"delete",
					"pod",
					name,
					"--ignore-not-found",
					"--wait=false",
				]);
			}
		}, 120_000);
	},
);
