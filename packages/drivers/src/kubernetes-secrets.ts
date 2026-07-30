import { secretMountPath } from "@pstdio/pocketcoder-contracts";
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
	for (const value of Object.values(spec.harness.env)) add(value);
	for (const step of spec.setup) for (const value of Object.values(step.env)) add(value);
	if (spec.checkpointHook) {
		for (const value of Object.values(spec.checkpointHook.env)) add(value);
	}
	if (spec.source && workspace.sourceDescriptor) {
		const credential = spec.source.repositories[workspace.sourceDescriptor.repository]?.credential;
		if (credential) add(credential);
	}
	return refs;
}

// Maps secretRef:<kubernetes-secret>/<key> to a read-only projected file.
// Values never pass through PocketCoder or provider input.
export class KubernetesSecretResolver implements WorkspaceSecretResolver {
	async resolve(workspace: WorkspaceRow): Promise<RuntimeSecretRef[]> {
		return [...collect(workspace)].map((reference) => {
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
}
