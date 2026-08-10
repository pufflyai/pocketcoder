import {
	agentApiHarness,
	isAgentApiNative,
	SOURCE_CREDENTIAL_MAX_BYTES,
	secretMountPath,
} from "@pstdio/pocketcoder-contracts";
import type {
	RuntimeSecretRef,
	WorkspaceRow,
	WorkspaceSecretResolver,
} from "@pstdio/pocketcoder-runtime-core";

function collect(workspace: WorkspaceRow): Set<string> {
	const refs = new Set<string>();
	const add = (value: string) => {
		if (value.startsWith("secretRef:")) refs.add(value);
	};
	const spec = workspace.templateSnapshot.spec;
	for (const value of Object.values(spec.env)) add(value);
	for (const value of Object.values(agentApiHarness(spec).env)) add(value);
	for (const step of spec.setup) for (const value of Object.values(step.env)) add(value);
	if (!isAgentApiNative(spec) && spec.checkpointHook) {
		for (const value of Object.values(spec.checkpointHook.env)) add(value);
	}
	return refs;
}

function parseReference(reference: string) {
	const [secretName, ...keyParts] = reference.slice("secretRef:".length).split("/");
	const key = keyParts.join("/");
	if (
		!secretName ||
		!key ||
		secretName.length > 253 ||
		key.length > 253 ||
		!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(secretName) ||
		!/^[A-Za-z0-9._-]+$/.test(key)
	) {
		throw new Error("Kubernetes secret refs must use secretRef:<secret-name>/<key>");
	}
	return { secretName, key };
}

export interface KubernetesSecretResolverOptions {
	namespace?: string;
	kubectlBin?: string;
}

// Runtime environment refs become read-only projected files. Source
// credentials take the separate setup-only control-channel path below.
export class KubernetesSecretResolver implements WorkspaceSecretResolver {
	private readonly namespace: string;
	private readonly kubectlBin: string;

	constructor(options: KubernetesSecretResolverOptions = {}) {
		this.namespace = options.namespace ?? "default";
		this.kubectlBin = options.kubectlBin ?? "kubectl";
	}

	async resolve(workspace: WorkspaceRow): Promise<RuntimeSecretRef[]> {
		return [...collect(workspace)].map((reference) => {
			const { secretName, key } = parseReference(reference);
			const volumeName =
				`${secretName}-${key.replace(/[^a-z0-9-]/gi, "-")}`
					.toLowerCase()
					.slice(0, 63)
					.replace(/-+$/g, "") || "secret";
			return {
				name: volumeName,
				target: secretMountPath(reference),
				source: { kind: "kubernetes-secret" as const, secretName, key },
			};
		});
	}

	async resolveSourceCredential(workspace: WorkspaceRow): Promise<string | null> {
		if (workspace.launchMode !== "create" || !workspace.sourceDescriptor) return null;
		const reference =
			workspace.templateSnapshot.spec.source?.repositories[workspace.sourceDescriptor.repository]
				?.credential;
		if (!reference) return null;
		const { secretName, key } = parseReference(reference);
		const proc = Bun.spawn(
			[
				this.kubectlBin,
				"--namespace",
				this.namespace,
				"--request-timeout=30s",
				"get",
				"secret",
				secretName,
				"-o",
				"json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) {
			throw new Error(`kubectl get secret failed (${code}): ${stderr.trim().slice(0, 500)}`);
		}
		const parsed = JSON.parse(stdout) as { data?: Record<string, string> };
		const encoded = parsed.data?.[key];
		if (!encoded) throw new Error(`Kubernetes Secret ${secretName} has no key ${key}`);
		const credential = Buffer.from(encoded, "base64").toString("utf8");
		if (Buffer.byteLength(credential) > SOURCE_CREDENTIAL_MAX_BYTES) {
			throw new Error("source credential exceeds the protocol limit");
		}
		return credential;
	}
}
