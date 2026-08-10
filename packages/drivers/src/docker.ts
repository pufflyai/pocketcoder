import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DiscoveredProvider,
  DiscoveredWarmProvider,
  ProviderRef,
  ProviderState,
  WarmRuntimeLaunch,
  WorkspaceDriver,
  WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";
import { appendSecurityOptions, appendWorkspaceMounts } from "./docker-args";
import { resolveDockerImage, runDocker } from "./docker-command";
import { createDockerEgress } from "./docker-egress";
import { type EgressDriverOptions, egressConfig, poolInput, workspaceInput } from "./egress";

export { resolveDockerImage } from "./docker-command";

// Docker implementation of the workspace-driver contract, intended for local
// development. It launches one immutable, resource-limited container per
// workspace with the template's security settings and a read-only provider
// input file. Production deployments use the Kubernetes Job driver.

export const WORKSPACE_LABEL = "pocketcoder.workspace";
export const DIGEST_LABEL = "pocketcoder.template-digest";
export const POOL_RUNTIME_LABEL = "pocketcoder.pool-runtime";

export interface DockerDriverOptions extends EgressDriverOptions {
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

export class DockerDriver implements WorkspaceDriver {
  readonly kind = "docker";
  private readonly opts: Required<Omit<DockerDriverOptions, keyof EgressDriverOptions>> &
    EgressDriverOptions;

  constructor(options: DockerDriverOptions = {}) {
    this.opts = {
      inputDir: options.inputDir ?? join(tmpdir(), "pocketcoder-inputs"),
      network: options.network ?? "",
      addHostGateway: options.addHostGateway ?? true,
      dockerBin: options.dockerBin ?? "docker",
      ...(options.egressImage ? { egressImage: options.egressImage } : {}),
      ...(options.egressSigningKey ? { egressSigningKey: options.egressSigningKey } : {}),
    };
  }

  private inputPath(workspaceId: string): string {
    return join(this.opts.inputDir, `${workspaceId}.json`);
  }

  private egressInputPath(id: string): string {
    return join(this.opts.inputDir, `${id}-egress.json`);
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
    const restricted = spec.network.mode === "restricted";
    const egressName = `pocketcoder-egress-${workspace.id}`;
    const egressFile = this.egressInputPath(workspace.id);
    let egressId: string | null = null;
    if (restricted) {
      await writeFile(
        egressFile,
        JSON.stringify(egressConfig(this.opts, input, spec.network, workspace.deadlineAt)),
        { mode: 0o600 },
      );
      egressId = await createDockerEgress(
        this.opts,
        egressName,
        `pocketcoder.egress-workspace=${workspace.id}`,
        DIGEST_LABEL,
        workspace.templateDigest,
        egressFile,
      );
    }
    await writeFile(inputFile, JSON.stringify(restricted ? workspaceInput(input) : input), {
      mode: 0o644,
    });

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
    appendWorkspaceMounts(args, launch);
    appendSecurityOptions(args, spec);
    if (egressId) {
      args.push("--network", `container:${egressId}`);
    } else if (this.opts.network) {
      args.push("--network", this.opts.network);
    }
    if (!egressId && this.opts.addHostGateway) {
      args.push("--add-host", "host.docker.internal:host-gateway");
    }
    for (const [key, value] of Object.entries(spec.env)) {
      if (value.startsWith("secretRef:")) continue;
      args.push("-e", `${key}=${value}`);
    }
    args.push(await resolveDockerImage(this.opts.dockerBin, spec.image), ...spec.command);

    try {
      const containerId = await runDocker(this.opts.dockerBin, args);
      return {
        kind: this.kind,
        id: containerId,
        name: `pocketcoder-ws-${workspace.id}`,
        ...(egressId ? { egressId, egressName } : {}),
      };
    } catch (err) {
      await rm(inputFile, { force: true });
      await rm(egressFile, { force: true });
      if (egressId) await runDocker(this.opts.dockerBin, ["rm", "-f", egressId]).catch(() => {});
      throw err;
    }
  }

  async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
    const spec = launch.template.spec;
    await mkdir(this.opts.inputDir, { recursive: true, mode: 0o700 });
    await chmod(this.opts.inputDir, 0o700);
    const inputFile = this.inputPath(`pool-${launch.runtimeId}`);
    const restricted = spec.network.mode === "restricted";
    const egressName = `pocketcoder-egress-pool-${launch.runtimeId}`;
    const egressFile = this.egressInputPath(`pool-${launch.runtimeId}`);
    let egressId: string | null = null;
    if (restricted) {
      await writeFile(
        egressFile,
        JSON.stringify(egressConfig(this.opts, launch.input, spec.network, launch.expiresAt)),
        { mode: 0o600 },
      );
      egressId = await createDockerEgress(
        this.opts,
        egressName,
        `pocketcoder.egress-pool=${launch.runtimeId}`,
        DIGEST_LABEL,
        launch.template.digest,
        egressFile,
      );
    }
    await writeFile(
      inputFile,
      JSON.stringify(restricted ? poolInput(launch.input) : launch.input),
      {
        mode: 0o644,
      },
    );
    const name = `pocketcoder-pool-${launch.runtimeId}`;
    const args = [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${POOL_RUNTIME_LABEL}=${launch.runtimeId}`,
      "--label",
      `${DIGEST_LABEL}=${launch.template.digest}`,
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
    appendSecurityOptions(args, spec);
    if (egressId) args.push("--network", `container:${egressId}`);
    else if (this.opts.network) args.push("--network", this.opts.network);
    if (!egressId && this.opts.addHostGateway)
      args.push("--add-host", "host.docker.internal:host-gateway");
    for (const [key, value] of Object.entries(spec.env)) args.push("-e", `${key}=${value}`);
    args.push(await resolveDockerImage(this.opts.dockerBin, spec.image), ...spec.command);
    try {
      const id = await runDocker(this.opts.dockerBin, args);
      return {
        kind: this.kind,
        id,
        name,
        poolRuntimeId: launch.runtimeId,
        ...(egressId ? { egressId, egressName } : {}),
      };
    } catch (error) {
      await rm(inputFile, { force: true });
      await rm(egressFile, { force: true });
      if (egressId) await runDocker(this.opts.dockerBin, ["rm", "-f", egressId]).catch(() => {});
      throw error;
    }
  }

  async inspect(ref: ProviderRef): Promise<ProviderState> {
    try {
      const out = await runDocker(this.opts.dockerBin, [
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
      await runDocker(this.opts.dockerBin, ["stop", "-t", String(graceSeconds), ref.id]);
    } catch {
      // Already stopped or gone.
    }
    if (typeof ref.egressId === "string") {
      await runDocker(this.opts.dockerBin, [
        "stop",
        "-t",
        String(graceSeconds),
        ref.egressId,
      ]).catch(() => {});
    }
  }

  async remove(ref: ProviderRef): Promise<void> {
    try {
      await runDocker(this.opts.dockerBin, ["rm", "-f", ref.id]);
    } catch {
      // Already removed.
    }
    if (typeof ref.egressId === "string") {
      await runDocker(this.opts.dockerBin, ["rm", "-f", ref.egressId]).catch(() => {});
    }
    const name = typeof ref.name === "string" ? ref.name : "";
    const poolRuntimeId = typeof ref.poolRuntimeId === "string" ? ref.poolRuntimeId : "";
    if (poolRuntimeId) {
      await rm(this.inputPath(`pool-${poolRuntimeId}`), { force: true });
      await rm(this.egressInputPath(`pool-${poolRuntimeId}`), { force: true });
      return;
    }
    const workspaceId = name.replace(/^pocketcoder-ws-/, "");
    if (workspaceId) {
      await rm(this.inputPath(workspaceId), { force: true });
      await rm(this.egressInputPath(workspaceId), { force: true });
    }
  }

  // Removes the provider input file once registration succeeded; the
  // one-time secret inside it is spent at that point anyway.
  async cleanupInput(workspaceId: string): Promise<void> {
    await rm(this.inputPath(workspaceId), { force: true });
    // The egress input contains the still-live audit token and remains mounted
    // only in the trusted companion until provider removal.
  }

  async cleanupWarmInput(runtimeId: string): Promise<void> {
    await rm(this.inputPath(`pool-${runtimeId}`), { force: true });
  }

  async list(): Promise<DiscoveredProvider[]> {
    const out = await runDocker(this.opts.dockerBin, [
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
        ref: {
          kind: this.kind,
          id,
          name: `pocketcoder-ws-${workspaceId}`,
          egressId: `pocketcoder-egress-${workspaceId}`,
          egressName: `pocketcoder-egress-${workspaceId}`,
        },
      };
    });
  }

  async listWarm(): Promise<DiscoveredWarmProvider[]> {
    const out = await runDocker(this.opts.dockerBin, [
      "ps",
      "--all",
      "--filter",
      `label=${POOL_RUNTIME_LABEL}`,
      "--format",
      `{{.ID}}\t{{.Label "${POOL_RUNTIME_LABEL}"}}\t{{.Label "${DIGEST_LABEL}"}}`,
    ]);
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [id = "", runtimeId = "", templateDigest = ""] = line.split("\t");
      return {
        runtimeId,
        templateDigest,
        ref: {
          kind: this.kind,
          id,
          name: `pocketcoder-pool-${runtimeId}`,
          poolRuntimeId: runtimeId,
          egressId: `pocketcoder-egress-pool-${runtimeId}`,
          egressName: `pocketcoder-egress-pool-${runtimeId}`,
        },
      };
    });
  }
}
