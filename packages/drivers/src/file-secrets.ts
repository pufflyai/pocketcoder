import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	agentApiHarness,
	isAgentApiNative,
	secretMountPath,
	type TemplateSpec,
} from "@pstdio/pocketcoder-contracts";
import type {
	RuntimeSecretRef,
	WorkspaceRow,
	WorkspaceSecretResolver,
} from "@pstdio/pocketcoder-runtime-core";

const SECRET_PREFIX = "secretRef:";

export interface FileSecretResolverOptions {
	root: string;
}

function collectReferences(spec: TemplateSpec, repository?: string): Set<string> {
	const references = new Set<string>();
	const collect = (env: Record<string, string>) => {
		for (const value of Object.values(env)) {
			if (value.startsWith(SECRET_PREFIX)) references.add(value);
		}
	};
	collect(spec.env);
	collect(agentApiHarness(spec).env);
	for (const step of spec.setup) collect(step.env);
	if (!isAgentApiNative(spec) && spec.checkpointHook) collect(spec.checkpointHook.env);
	if (repository && spec.source) {
		const credential = spec.source.repositories[repository]?.credential;
		if (credential) references.add(credential);
	}
	return references;
}

export class FileSecretResolver implements WorkspaceSecretResolver {
	private readonly root: string;

	constructor(options: FileSecretResolverOptions) {
		if (!isAbsolute(options.root)) throw new Error("secret root must be absolute");
		this.root = resolve(options.root);
		if (this.root === resolve("/")) throw new Error("secret root must not be /");
	}

	async resolve(workspace: WorkspaceRow): Promise<RuntimeSecretRef[]> {
		const references = collectReferences(
			workspace.templateSnapshot.spec,
			workspace.sourceDescriptor?.repository,
		);
		const rootReal = await realpath(this.root);
		const result: RuntimeSecretRef[] = [];
		for (const reference of references) {
			const relativeName = reference.slice(SECRET_PREFIX.length);
			secretMountPath(reference);
			const candidate = resolve(this.root, relativeName);
			const candidateReal = await realpath(candidate);
			if (relative(rootReal, candidateReal).startsWith("..") || candidateReal === rootReal) {
				throw new Error("secret reference escaped the configured root");
			}
			const stat = await lstat(candidateReal);
			if (!stat.isFile() || stat.size > 1_048_576) {
				throw new Error("secret reference is not a bounded regular file");
			}
			result.push({
				name: relativeName.replaceAll("/", "_"),
				target: secretMountPath(reference),
				source: { kind: "host-path", path: candidateReal },
			});
		}
		return result;
	}
}
