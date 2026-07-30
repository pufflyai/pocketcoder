import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DiscoveredProvider,
	ProviderRef,
	ProviderState,
	WorkspaceDriver,
	WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";

// Docker implementation of the workspace-driver contract, intended for local
// development. It launches one immutable, resource-limited container per
// workspace with the template's security settings and a read-only provider
// input file. Production deployments use the Kubernetes Job driver.

export const WORKSPACE_LABEL = "pocketcoder.workspace";
export const DIGEST_LABEL = "pocketcoder.template-digest";

export interface DockerDriverOptions {
	// Private directory for temporary provider input files, removed on
	// termination and after registration.
	inputDir?: string;
	// Docker network to attach; defaults to the docker default bridge.
	network?: string;
	// Adds host.docker.internal:host-gateway so workspaces can reach a
	// pocketcoder-server running on the host during development.
	addHostGateway?: boolean;
	dockerBin?: string;
}

async function run(bin: string, args: string[]): Promise<string> {
	const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`docker ${args[0]} failed (${code}): ${stderr.trim().slice(0, 500)}`);
	}
	return stdout.trim();
}

// Local builds have an immutable image ID but no registry manifest digest.
// When the digest portion is an exact local image ID, run that ID directly;
// otherwise preserve the repository@digest reference for Docker to resolve.
export async function resolveDockerImage(dockerBin: string, image: string): Promise<string> {
	const separator = image.lastIndexOf("@");
	if (separator === -1) return image;
	const digest = image.slice(separator + 1);
	try {
		const localId = await run(dockerBin, ["image", "inspect", digest, "--format", "{{.Id}}"]);
		if (localId === digest) return digest;
	} catch {
		// Registry digest references are not necessarily addressable as local
		// image IDs, so Docker should receive the original reference.
	}
	return image;
}

export class DockerDriver implements WorkspaceDriver {
	readonly kind = "docker";
	private readonly opts: Required<DockerDriverOptions>;

	constructor(options: DockerDriverOptions = {}) {
		this.opts = {
			inputDir: options.inputDir ?? join(tmpdir(), "pocketcoder-inputs"),
			network: options.network ?? "",
			addHostGateway: options.addHostGateway ?? true,
			dockerBin: options.dockerBin ?? "docker",
		};
	}

	private inputPath(workspaceId: string): string {
		return join(this.opts.inputDir, `${workspaceId}.json`);
	}

	async create(launch: WorkspaceLaunch): Promise<ProviderRef> {
		const { workspace, input } = launch;
		const spec = workspace.templateSnapshot.spec;
		await mkdir(this.opts.inputDir, { recursive: true, mode: 0o700 });
		await chmod(this.opts.inputDir, 0o700);
		const inputFile = this.inputPath(workspace.id);
		// The non-root workspace UID normally differs from the host server UID
		// on Linux. The private 0700 directory protects the file on the host;
		// 0644 lets that workspace UID read the individual read-only bind mount.
		await writeFile(inputFile, JSON.stringify(input), { mode: 0o644 });

		const args = [
			"run",
			"--detach",
			"--name",
			`pocketcoder-ws-${workspace.id}`,
			"--label",
			`${WORKSPACE_LABEL}=${workspace.id}`,
			"--label",
			`${DIGEST_LABEL}=${workspace.templateDigest}`,
			"--restart=no",
			"--user",
			`${spec.security.uid}:${spec.security.gid}`,
			"--security-opt",
			"no-new-privileges",
			"--cpus",
			spec.resources.cpu.endsWith("m")
				? String(Number(spec.resources.cpu.slice(0, -1)) / 1000)
				: spec.resources.cpu,
			"--memory",
			spec.resources.memory.replace("Mi", "m").replace("Gi", "g"),
			"-v",
			`${inputFile}:/run/pocketcoder/input:ro`,
		];
		for (const mount of launch.mounts) {
			if (mount.source.kind !== "host-path") {
				throw new Error(
					`docker driver cannot consume ${mount.source.kind} storage; configure a host-path storage backend`,
				);
			}
			args.push(
				"--mount",
				`type=bind,src=${mount.source.path},dst=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
			);
		}
		for (const secret of launch.secrets) {
			if (secret.source.kind !== "host-path") {
				throw new Error(
					`docker driver cannot consume ${secret.source.kind} secrets; configure a file secret resolver`,
				);
			}
			args.push("--mount", `type=bind,src=${secret.source.path},dst=${secret.target},readonly`);
		}
		for (const cap of spec.security.dropCapabilities) {
			args.push("--cap-drop", cap);
		}
		if (spec.security.readOnlyRoot) {
			args.push("--read-only");
		}
		for (const path of spec.security.writableMemoryPaths) {
			args.push("--tmpfs", `${path}:rw,noexec,nosuid,size=256m`);
		}
		if (this.opts.network) {
			args.push("--network", this.opts.network);
		}
		if (this.opts.addHostGateway) {
			args.push("--add-host", "host.docker.internal:host-gateway");
		}
		for (const [key, value] of Object.entries(spec.env)) {
			if (value.startsWith("secretRef:")) continue;
			args.push("-e", `${key}=${value}`);
		}
		args.push(await resolveDockerImage(this.opts.dockerBin, spec.image), ...spec.command);

		try {
			const containerId = await run(this.opts.dockerBin, args);
			return { kind: this.kind, id: containerId, name: `pocketcoder-ws-${workspace.id}` };
		} catch (err) {
			await rm(inputFile, { force: true });
			throw err;
		}
	}

	async inspect(ref: ProviderRef): Promise<ProviderState> {
		try {
			const out = await run(this.opts.dockerBin, [
				"inspect",
				"--format",
				"{{.State.Running}} {{.State.ExitCode}}",
				ref.id,
			]);
			const [running, exitCode] = out.split(" ");
			return {
				exists: true,
				running: running === "true",
				exitCode: running === "true" ? null : Number(exitCode),
			};
		} catch {
			return { exists: false, running: false, exitCode: null };
		}
	}

	async stop(ref: ProviderRef, graceSeconds: number): Promise<void> {
		try {
			await run(this.opts.dockerBin, ["stop", "-t", String(graceSeconds), ref.id]);
		} catch {
			// Already stopped or gone.
		}
	}

	async remove(ref: ProviderRef): Promise<void> {
		try {
			await run(this.opts.dockerBin, ["rm", "-f", ref.id]);
		} catch {
			// Already removed.
		}
		const name = typeof ref.name === "string" ? ref.name : "";
		const workspaceId = name.replace(/^pocketcoder-ws-/, "");
		if (workspaceId) {
			await rm(this.inputPath(workspaceId), { force: true });
		}
	}

	// Removes the provider input file once registration succeeded; the
	// one-time secret inside it is spent at that point anyway.
	async cleanupInput(workspaceId: string): Promise<void> {
		await rm(this.inputPath(workspaceId), { force: true });
	}

	async list(): Promise<DiscoveredProvider[]> {
		const out = await run(this.opts.dockerBin, [
			"ps",
			"--all",
			"--filter",
			`label=${WORKSPACE_LABEL}`,
			"--format",
			`{{.ID}}\t{{.Label "${WORKSPACE_LABEL}"}}\t{{.Label "${DIGEST_LABEL}"}}`,
		]);
		if (!out) return [];
		return out.split("\n").map((line) => {
			const [id = "", workspaceId = "", templateDigest = ""] = line.split("\t");
			return {
				workspaceId,
				templateDigest,
				ref: { kind: this.kind, id, name: `pocketcoder-ws-${workspaceId}` },
			};
		});
	}
}
