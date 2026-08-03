import type {
	DiscoveredProvider,
	DiscoveredWarmProvider,
	ProviderRef,
	ProviderState,
	RuntimeMountRef,
	RuntimeSecretRef,
	WarmRuntimeLaunch,
	WorkspaceDriver,
	WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";

export const KUBERNETES_WORKSPACE_LABEL = "pocketcoder.workspace";
export const KUBERNETES_DIGEST_ANNOTATION = "pocketcoder.dev/template-digest";
export const KUBERNETES_POOL_LABEL = "pocketcoder.pool-runtime";

export interface KubernetesDriverOptions {
	namespace?: string;
	kubectlBin?: string;
	serviceAccountName?: string;
	imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
}

async function kubectl(
	bin: string,
	namespace: string,
	args: string[],
	input?: string,
): Promise<string> {
	const proc = Bun.spawn([bin, "--namespace", namespace, "--request-timeout=30s", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		...(input === undefined ? {} : { stdin: "pipe" }),
	});
	if (input !== undefined && proc.stdin) {
		proc.stdin.write(input);
		proc.stdin.end();
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`kubectl ${args[0]} failed (${code}): ${stderr.trim().slice(0, 500)}`);
	}
	return stdout.trim();
}

function resourceName(workspaceId: string): string {
	return `pocketcoder-ws-${workspaceId}`;
}

function isKubernetesName(value: string): boolean {
	return value.length <= 253 && /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(value);
}

function volumeForMount(mount: RuntimeMountRef, index: number) {
	const name = `persistent-${index}`;
	if (mount.source.kind === "pvc") {
		return {
			name,
			volume: {
				name,
				persistentVolumeClaim: { claimName: mount.source.claimName },
			},
			mount: {
				name,
				mountPath: mount.target,
				readOnly: mount.readOnly ?? false,
				...(mount.source.subPath ? { subPath: mount.source.subPath } : {}),
			},
		};
	}
	return {
		name,
		volume: {
			name,
			hostPath: { path: mount.source.path, type: "Directory" },
		},
		mount: {
			name,
			mountPath: mount.target,
			readOnly: mount.readOnly ?? false,
		},
	};
}

function volumeForSecret(secret: RuntimeSecretRef, index: number) {
	const name = `secret-${index}`;
	if (secret.source.kind === "kubernetes-secret") {
		return {
			volume: {
				name,
				secret: {
					secretName: secret.source.secretName,
					items: [{ key: secret.source.key, path: "value" }],
				},
			},
			mount: {
				name,
				mountPath: secret.target,
				subPath: "value",
				readOnly: true,
			},
		};
	}
	return {
		volume: {
			name,
			hostPath: { path: secret.source.path, type: "File" },
		},
		mount: {
			name,
			mountPath: secret.target,
			readOnly: true,
		},
	};
}

export class KubernetesDriver implements WorkspaceDriver {
	readonly kind = "kubernetes";
	private readonly namespace: string;
	private readonly kubectlBin: string;
	private readonly serviceAccountName: string | undefined;
	private readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";

	constructor(options: KubernetesDriverOptions = {}) {
		this.namespace = options.namespace ?? "default";
		if (!isKubernetesName(this.namespace)) {
			throw new Error("namespace must be a Kubernetes resource name");
		}
		this.kubectlBin = options.kubectlBin ?? "kubectl";
		this.serviceAccountName = options.serviceAccountName;
		if (this.serviceAccountName && !isKubernetesName(this.serviceAccountName)) {
			throw new Error("serviceAccountName must be a Kubernetes resource name");
		}
		this.imagePullPolicy = options.imagePullPolicy ?? "IfNotPresent";
	}

	async create(launch: WorkspaceLaunch): Promise<ProviderRef> {
		const { workspace, input } = launch;
		const spec = workspace.templateSnapshot.spec;
		const name = resourceName(workspace.id);
		const inputSecret = `${name}-input`;
		const inputManifest = {
			apiVersion: "v1",
			kind: "Secret",
			metadata: {
				name: inputSecret,
				labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id },
			},
			type: "Opaque",
			stringData: { "input.json": JSON.stringify(input) },
		};
		await kubectl(
			this.kubectlBin,
			this.namespace,
			["apply", "-f", "-"],
			JSON.stringify(inputManifest),
		);

		const persistent = launch.mounts.map(volumeForMount);
		const secrets = launch.secrets.map(volumeForSecret);
		const memory = spec.security.writableMemoryPaths.map((path, index) => ({
			volume: { name: `memory-${index}`, emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
			mount: { name: `memory-${index}`, mountPath: path },
		}));
		const manifest = {
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: {
				name,
				labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id },
				annotations: { [KUBERNETES_DIGEST_ANNOTATION]: workspace.templateDigest },
			},
			spec: {
				backoffLimit: 0,
				ttlSecondsAfterFinished: 3600,
				template: {
					metadata: {
						labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id },
						annotations: {
							[KUBERNETES_DIGEST_ANNOTATION]: workspace.templateDigest,
						},
					},
					spec: {
						restartPolicy: "Never",
						automountServiceAccountToken: false,
						...(this.serviceAccountName ? { serviceAccountName: this.serviceAccountName } : {}),
						securityContext: {
							runAsUser: spec.security.uid,
							runAsGroup: spec.security.gid,
							runAsNonRoot: true,
							fsGroup: spec.security.gid,
							fsGroupChangePolicy: "OnRootMismatch",
							seccompProfile: { type: spec.security.seccomp },
						},
						containers: [
							{
								name: "workspace",
								image: spec.image,
								imagePullPolicy: this.imagePullPolicy,
								command: spec.command,
								env: Object.entries(spec.env)
									.filter(([, value]) => !value.startsWith("secretRef:"))
									.map(([name, value]) => ({ name, value })),
								resources: {
									requests: {
										cpu: spec.resources.cpu,
										memory: spec.resources.memory,
									},
									limits: {
										cpu: spec.resources.cpu,
										memory: spec.resources.memory,
									},
								},
								securityContext: {
									readOnlyRootFilesystem: spec.security.readOnlyRoot,
									allowPrivilegeEscalation: spec.security.allowPrivilegeEscalation,
									capabilities: { drop: spec.security.dropCapabilities },
								},
								volumeMounts: [
									{
										name: "provider-input",
										mountPath: "/run/pocketcoder/input",
										subPath: "input.json",
										readOnly: true,
									},
									...persistent.map((item) => item.mount),
									...secrets.map((item) => item.mount),
									...memory.map((item) => item.mount),
								],
							},
						],
						volumes: [
							{
								name: "provider-input",
								secret: {
									secretName: inputSecret,
									items: [{ key: "input.json", path: "input.json" }],
								},
							},
							...persistent.map((item) => item.volume),
							...secrets.map((item) => item.volume),
							...memory.map((item) => item.volume),
						],
					},
				},
			},
		};
		try {
			await kubectl(
				this.kubectlBin,
				this.namespace,
				["apply", "-f", "-"],
				JSON.stringify(manifest),
			);
			return {
				kind: this.kind,
				id: name,
				name,
				inputSecret,
				namespace: this.namespace,
			};
		} catch (error) {
			await kubectl(this.kubectlBin, this.namespace, [
				"delete",
				"secret",
				inputSecret,
				"--ignore-not-found",
			]).catch(() => {});
			throw error;
		}
	}

	async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
		const spec = launch.template.spec;
		const name = `pocketcoder-pool-${launch.runtimeId}`;
		const inputSecret = `${name}-input`;
		await kubectl(
			this.kubectlBin,
			this.namespace,
			["apply", "-f", "-"],
			JSON.stringify({
				apiVersion: "v1",
				kind: "Secret",
				metadata: { name: inputSecret, labels: { [KUBERNETES_POOL_LABEL]: launch.runtimeId } },
				type: "Opaque",
				stringData: { "input.json": JSON.stringify(launch.input) },
			}),
		);
		const memory = spec.security.writableMemoryPaths.map((path, index) => ({
			volume: { name: `memory-${index}`, emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
			mount: { name: `memory-${index}`, mountPath: path },
		}));
		const labels = { [KUBERNETES_POOL_LABEL]: launch.runtimeId };
		const annotations = { [KUBERNETES_DIGEST_ANNOTATION]: launch.template.digest };
		const manifest = {
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name, labels, annotations },
			spec: {
				backoffLimit: 0,
				ttlSecondsAfterFinished: 3600,
				template: {
					metadata: { labels, annotations },
					spec: {
						restartPolicy: "Never",
						automountServiceAccountToken: false,
						...(this.serviceAccountName ? { serviceAccountName: this.serviceAccountName } : {}),
						securityContext: {
							runAsUser: spec.security.uid,
							runAsGroup: spec.security.gid,
							runAsNonRoot: true,
							fsGroup: spec.security.gid,
							fsGroupChangePolicy: "OnRootMismatch",
							seccompProfile: { type: spec.security.seccomp },
						},
						containers: [
							{
								name: "workspace",
								image: spec.image,
								imagePullPolicy: this.imagePullPolicy,
								command: spec.command,
								env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
								resources: { requests: spec.resources, limits: spec.resources },
								securityContext: {
									readOnlyRootFilesystem: spec.security.readOnlyRoot,
									allowPrivilegeEscalation: spec.security.allowPrivilegeEscalation,
									capabilities: { drop: spec.security.dropCapabilities },
								},
								volumeMounts: [
									{
										name: "provider-input",
										mountPath: "/run/pocketcoder/input",
										subPath: "input.json",
										readOnly: true,
									},
									...memory.map((item) => item.mount),
								],
							},
						],
						volumes: [
							{
								name: "provider-input",
								secret: {
									secretName: inputSecret,
									items: [{ key: "input.json", path: "input.json" }],
								},
							},
							...memory.map((item) => item.volume),
						],
					},
				},
			},
		};
		try {
			await kubectl(
				this.kubectlBin,
				this.namespace,
				["apply", "-f", "-"],
				JSON.stringify(manifest),
			);
			return {
				kind: this.kind,
				id: name,
				name,
				inputSecret,
				namespace: this.namespace,
				poolRuntimeId: launch.runtimeId,
			};
		} catch (error) {
			await kubectl(this.kubectlBin, this.namespace, [
				"delete",
				"secret",
				inputSecret,
				"--ignore-not-found",
			]).catch(() => {});
			throw error;
		}
	}

	async inspect(ref: ProviderRef): Promise<ProviderState> {
		try {
			const output = await kubectl(this.kubectlBin, this.namespace, [
				"get",
				"job",
				ref.id,
				"-o",
				"json",
			]);
			const job = JSON.parse(output) as {
				status?: { active?: number; succeeded?: number; failed?: number };
			};
			const running = (job.status?.active ?? 0) > 0;
			return {
				exists: true,
				running,
				exitCode:
					running || !(job.status?.succeeded || job.status?.failed)
						? null
						: job.status.succeeded
							? 0
							: 1,
			};
		} catch {
			return { exists: false, running: false, exitCode: null };
		}
	}

	async stop(ref: ProviderRef, graceSeconds: number): Promise<void> {
		await kubectl(this.kubectlBin, this.namespace, [
			"patch",
			"job",
			ref.id,
			"--type=merge",
			"-p",
			'{"spec":{"suspend":true}}',
		]).catch(() => {});
		await kubectl(this.kubectlBin, this.namespace, [
			"delete",
			"pod",
			"-l",
			`job-name=${ref.id}`,
			`--grace-period=${graceSeconds}`,
			"--wait=true",
			"--ignore-not-found",
		]).catch(() => {});
	}

	async remove(ref: ProviderRef): Promise<void> {
		await kubectl(this.kubectlBin, this.namespace, [
			"delete",
			"job",
			ref.id,
			"--ignore-not-found",
			"--wait=true",
		]).catch(() => {});
		const inputSecret = typeof ref.inputSecret === "string" ? ref.inputSecret : `${ref.id}-input`;
		await kubectl(this.kubectlBin, this.namespace, [
			"delete",
			"secret",
			inputSecret,
			"--ignore-not-found",
		]).catch(() => {});
	}

	async cleanupInput(workspaceId: string): Promise<void> {
		await kubectl(this.kubectlBin, this.namespace, [
			"delete",
			"secret",
			`${resourceName(workspaceId)}-input`,
			"--ignore-not-found",
		]).catch(() => {});
	}

	async cleanupWarmInput(runtimeId: string): Promise<void> {
		await kubectl(this.kubectlBin, this.namespace, [
			"delete",
			"secret",
			`pocketcoder-pool-${runtimeId}-input`,
			"--ignore-not-found",
		]).catch(() => {});
	}

	async list(): Promise<DiscoveredProvider[]> {
		const output = await kubectl(this.kubectlBin, this.namespace, [
			"get",
			"jobs",
			"-l",
			KUBERNETES_WORKSPACE_LABEL,
			"-o",
			"json",
		]);
		const list = JSON.parse(output) as {
			items?: Array<{
				metadata?: {
					name?: string;
					labels?: Record<string, string>;
					annotations?: Record<string, string>;
				};
			}>;
		};
		return (list.items ?? []).flatMap((job) => {
			const workspaceId = job.metadata?.labels?.[KUBERNETES_WORKSPACE_LABEL];
			const name = job.metadata?.name;
			const templateDigest = job.metadata?.annotations?.[KUBERNETES_DIGEST_ANNOTATION];
			if (!workspaceId || !name || !templateDigest) return [];
			return [
				{
					workspaceId,
					templateDigest,
					ref: {
						kind: this.kind,
						id: name,
						name,
						inputSecret: `${name}-input`,
						namespace: this.namespace,
					},
				},
			];
		});
	}

	async listWarm(): Promise<DiscoveredWarmProvider[]> {
		const output = await kubectl(this.kubectlBin, this.namespace, [
			"get",
			"jobs",
			"-l",
			KUBERNETES_POOL_LABEL,
			"-o",
			"json",
		]);
		const list = JSON.parse(output) as {
			items?: Array<{
				metadata?: {
					name?: string;
					labels?: Record<string, string>;
					annotations?: Record<string, string>;
				};
			}>;
		};
		return (list.items ?? []).flatMap((job) => {
			const runtimeId = job.metadata?.labels?.[KUBERNETES_POOL_LABEL];
			const name = job.metadata?.name;
			const templateDigest = job.metadata?.annotations?.[KUBERNETES_DIGEST_ANNOTATION];
			if (!runtimeId || !name || !templateDigest) return [];
			return [
				{
					runtimeId,
					templateDigest,
					ref: {
						kind: this.kind,
						id: name,
						name,
						inputSecret: `${name}-input`,
						namespace: this.namespace,
						poolRuntimeId: runtimeId,
					},
				},
			];
		});
	}
}
