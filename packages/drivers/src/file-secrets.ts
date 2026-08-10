import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
	agentApiHarness,
	isAgentApiNative,
	SOURCE_CREDENTIAL_MAX_BYTES,
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

function collectReferences(spec: TemplateSpec): Set<string> {
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
	return references;
}

function sourceCredentialReference(workspace: WorkspaceRow): string | null {
	const source = workspace.sourceDescriptor;
	if (!source || workspace.launchMode !== "create") return null;
	return (
		workspace.templateSnapshot.spec.source?.repositories[source.repository]?.credential ?? null
	);
}

export class FileSecretResolver implements WorkspaceSecretResolver {
	private readonly root: string;

	constructor(options: FileSecretResolverOptions) {
		if (!isAbsolute(options.root)) throw new Error("secret root must be absolute");
		this.root = resolve(options.root);
		if (this.root === resolve("/")) throw new Error("secret root must not be /");
	}

	private async file(reference: string) {
		const rootReal = await realpath(this.root);
		const relativeName = reference.slice(SECRET_PREFIX.length);
		secretMountPath(reference);
		const candidateReal = await realpath(resolve(this.root, relativeName));
		if (relative(rootReal, candidateReal).startsWith("..") || candidateReal === rootReal) {
			throw new Error("secret reference escaped the configured root");
		}
		const stat = await lstat(candidateReal);
		if (!stat.isFile() || stat.size > 1_048_576) {
			throw new Error("secret reference is not a bounded regular file");
		}
		return { relativeName, path: candidateReal };
	}

	async resolve(workspace: WorkspaceRow): Promise<RuntimeSecretRef[]> {
		const result: RuntimeSecretRef[] = [];
		for (const reference of collectReferences(workspace.templateSnapshot.spec)) {
			const file = await this.file(reference);
			result.push({
				name: file.relativeName.replaceAll("/", "_"),
				target: secretMountPath(reference),
				source: { kind: "host-path", path: file.path },
			});
		}
		return result;
	}

	async resolveSourceCredential(workspace: WorkspaceRow): Promise<string | null> {
		const reference = sourceCredentialReference(workspace);
		if (!reference) return null;
		const file = await this.file(reference);
		const stat = await lstat(file.path);
		if (stat.size > SOURCE_CREDENTIAL_MAX_BYTES) {
			throw new Error("source credential exceeds the protocol limit");
		}
		return await readFile(file.path, "utf8");
	}
}
