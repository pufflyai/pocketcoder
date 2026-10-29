import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  DiscoveredProvider,
  DiscoveredWarmProvider,
  InputProjectionRef,
  ProviderRef,
  ProviderState,
  WarmRuntimeLaunch,
  WorkspaceDriver,
  WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";
import { type EgressDriverOptions, egressConfig, workspaceInput } from "../egress/egress";
import type { ProjectionScope } from "../filesystem/input-projection";
import type { RegistryResolver } from "../registry/registry";
import { appendSecurityOptions, appendWorkspaceMounts } from "./docker-args";
import { resolveDockerImage, runDocker } from "./docker-command";
import { createDockerEgress } from "./docker-egress";
import { type DockerInputProjectionOptions, DockerInputs, PROJECTION_LABEL } from "./docker-inputs";
import { pullPrivateImage } from "./docker-registry";
import { createWarmDocker, listWarmDocker } from "./docker-warm";
import { DockerWorkloads } from "./docker-workloads";

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
  inputProjection?: DockerInputProjectionOptions;
  // Docker network to attach; defaults to the docker default bridge.
  network?: string;
  // Adds host.docker.internal:host-gateway so workspaces can reach a
  // pocketcoder-server running on the host during development.
  addHostGateway?: boolean;
  dockerBin?: string;
  resolveRegistry?: RegistryResolver;
}

export type ResolvedDockerOptions = Required<
  Omit<DockerDriverOptions, keyof EgressDriverOptions | "resolveRegistry" | "inputProjection">
> &
  EgressDriverOptions &
  Pick<DockerDriverOptions, "resolveRegistry">;

export class DockerDriver implements WorkspaceDriver {
  readonly kind = "docker";
  private readonly inputs?: DockerInputs;
  private readonly opts: ResolvedDockerOptions;
  private readonly workloads: DockerWorkloads;

  constructor(options: DockerDriverOptions = {}) {
    this.inputs = options.inputProjection
      ? new DockerInputs(
          options.dockerBin ?? "docker",
          options.inputProjection,
          options.inputDir ?? join(tmpdir(), "pocketcoder-inputs"),
        )
      : undefined;
    this.workloads = new DockerWorkloads(options.dockerBin ?? "docker");
    this.opts = {
      ...(options.resolveRegistry ? { resolveRegistry: options.resolveRegistry } : {}),
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
    const projection = await this.inputs?.prepare(launch);
    try {
      return await this.createWorkspace(launch, projection);
    } catch (error) {
      if (projection) await this.inputs?.discard(projection);
      throw error;
    }
  }

  private async createWorkspace(launch: WorkspaceLaunch, projection?: ProjectionScope): Promise<ProviderRef> {
    const { workspace, input } = launch;
    const spec = workspace.templateSnapshot.spec;
    if (spec.imagePullSecret) {
      if (!this.opts.resolveRegistry) throw new Error("Stored registry credentials are unavailable");
      await pullPrivateImage(
        this.opts.dockerBin,
        spec.image,
        await this.opts.resolveRegistry(spec.imagePullSecret, spec.image),
      );
    }
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
      await writeFile(egressFile, JSON.stringify(egressConfig(this.opts, input, spec.network, workspace.deadlineAt)), {
        mode: 0o600,
      });
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
      spec.resources.cpu.endsWith("m") ? String(Number(spec.resources.cpu.slice(0, -1)) / 1000) : spec.resources.cpu,
      "--memory",
      spec.resources.memory.replace("Mi", "m").replace("Gi", "g"),
      "-v",
      `${inputFile}:/run/pocketcoder/input:ro`,
    ];
    if (projection && this.inputs) args.push(...this.inputs.args(projection));
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
      const ref = {
        kind: this.kind,
        ...this.workloads.reference(workspace),
        id: containerId,
        ...(projection ? { workspaceId: workspace.id, inputProjectionId: projection.projectionId } : {}),
        name: `pocketcoder-ws-${workspace.id}`,
        ...(egressId ? { egressId, egressName } : {}),
      };
      await this.verifyCreatedProjection(ref, projection);
      return ref;
    } catch (err) {
      await rm(inputFile, { force: true });
      await rm(egressFile, { force: true });
      if (egressId) await runDocker(this.opts.dockerBin, ["rm", "-f", egressId]).catch(() => {});
      throw err;
    }
  }

  private async verifyCreatedProjection(ref: ProviderRef, projection?: ProjectionScope) {
    if (projection && this.inputs) {
      try {
        await this.inputs.inspect(ref);
      } catch (error) {
        await runDocker(this.opts.dockerBin, ["rm", "-f", ref.id]);
        throw error;
      }
    }
  }

  async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
    if (this.inputs)
      throw new Error("Immutable input projections require a fresh workspace; warm pools are unsupported.");
    return createWarmDocker(this.opts, launch);
  }

  async publishInputs(ref: ProviderRef, input: InputProjectionRef) {
    if (!this.inputs) throw new Error("Docker daemon-host immutable input storage is not configured.");
    return this.inputs.publish(ref, input);
  }
  async releaseInputProjection(ref: ProviderRef, manifestId: string) {
    if (!this.inputs) throw new Error("Docker daemon-host immutable input storage is not configured.");
    await this.inputs.release(ref, manifestId);
  }

  async inspect(ref: ProviderRef): Promise<ProviderState> {
    try {
      const out = await runDocker(this.opts.dockerBin, [
        "inspect",
        "--format",
        "{{.State.Running}} {{.State.ExitCode}} {{.Id}} {{.State.StartedAt}}",
        ref.id,
      ]);
      const [running, exitCode, containerId, startedAt] = out.split(" ");
      const state: ProviderState = {
        exists: true,
        // A manual restart keeps the container ID and can keep RestartCount at zero.
        containerIdentity: `${containerId}@${startedAt}`,
        running: running === "true",
        exitCode: running === "true" ? null : Number(exitCode),
      };
      if (this.inputs && ref.inputProjectionId) {
        try {
          state.inputStorage = await this.inputs.inspect(ref);
        } catch (error) {
          state.detail = String(error);
        }
      }
      state.workload = await this.workloads.inspect(ref, state, state.inputStorage);
      return state;
    } catch (error) {
      // A daemon outage is not evidence that the runtime disappeared.
      if (!(error instanceof Error) || !/No such (object|container)/i.test(error.message)) throw error;
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
      await runDocker(this.opts.dockerBin, ["stop", "-t", String(graceSeconds), ref.egressId]).catch(() => {});
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
    if (this.inputs && ref.inputProjectionId) await this.inputs.remove(ref);
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

  async purgeInput(workspaceId: string): Promise<void> {
    await this.inputs?.purge(workspaceId);
    await rm(this.inputPath(workspaceId), { force: true });
    await rm(this.egressInputPath(workspaceId), { force: true });
  }

  // The registration secret is spent; the egress token is still live.
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
      "--no-trunc",
      "--filter",
      `label=${WORKSPACE_LABEL}`,
      "--format",
      `{{.ID}}\t{{.Label "${WORKSPACE_LABEL}"}}\t{{.Label "${DIGEST_LABEL}"}}\t{{.Label "${PROJECTION_LABEL}"}}`,
    ]);
    if (!out) return [];
    return out.split("\n").map((line) => {
      const [id = "", workspaceId = "", templateDigest = "", projectionId = ""] = line.split("\t");
      return {
        workspaceId,
        templateDigest,
        ref: {
          kind: this.kind,
          id,
          name: `pocketcoder-ws-${workspaceId}`,
          ...(projectionId ? { workspaceId, inputProjectionId: projectionId } : {}),
          egressId: `pocketcoder-egress-${workspaceId}`,
          egressName: `pocketcoder-egress-${workspaceId}`,
        },
      };
    });
  }

  async listWarm(): Promise<DiscoveredWarmProvider[]> {
    return listWarmDocker(this.opts.dockerBin);
  }
}
