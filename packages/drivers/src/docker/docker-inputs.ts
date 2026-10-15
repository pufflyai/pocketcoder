import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { credentialMemoryPaths, WorkloadImageSchema } from "@pstdio/pocketcoder-contracts";
import type {
  InputProjectionRef,
  InputStorageDriver,
  ProviderRef,
  WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";
import {
  FilesystemInputProjection,
  INPUT_PROJECTION_TARGET,
  type ProjectionScope,
} from "../filesystem/input-projection";
import { inputId, overlaps, privateRoot } from "../filesystem/projection-paths";
import { resolveDockerImage, runDocker } from "./docker-command";

import { type PrivateInputBacking, probeDaemonHost, verifyContainerInputBoundary } from "./docker-input-boundary";

export const PROJECTION_LABEL = "pocketcoder.input-projection";
export interface DockerInputProjectionOptions {
  root: string;
  storage: InputStorageDriver;
  privateRoots: string[];
  capacity: { bytes: number; files: number };
  // Deployment-owned, pinned image with /bin/sh and cat for the daemon-host probe.
  probeImage: string;
}

export class DockerInputs {
  private image?: Promise<string>;
  private privateBackings?: PrivateInputBacking[];
  private readonly privateRoots: string[];
  private probeImage() {
    this.image ??= resolveDockerImage(this.bin, this.options.probeImage);
    return this.image;
  }
  private readonly publisher: FilesystemInputProjection;
  constructor(
    private readonly bin: string,
    private readonly options: DockerInputProjectionOptions,
    inputDir: string,
  ) {
    WorkloadImageSchema.parse(options.probeImage);
    this.publisher = new FilesystemInputProjection(options);
    this.privateRoots = options.privateRoots.map(privateRoot);
    this.publisher.assertMountSource(inputDir);
  }
  private scope(ref: ProviderRef): ProjectionScope {
    if (ref.kind !== "docker" || typeof ref.workspaceId !== "string" || typeof ref.inputProjectionId !== "string")
      throw new Error("Immutable input projection is unavailable for this incarnation.");
    return { workspaceId: inputId(ref.workspaceId), projectionId: inputId(ref.inputProjectionId) };
  }
  async prepare(launch: WorkspaceLaunch) {
    const spec = launch.workspace.templateSnapshot.spec;
    if (!spec.security.readOnlyRoot || !spec.security.dropCapabilities.includes("ALL"))
      throw new Error("Immutable input storage requires a read-only root and all capabilities dropped.");
    const targets = [...launch.mounts, ...launch.secrets].map((mount) => mount.target);
    targets.push(...credentialMemoryPaths(spec));
    for (const target of targets) {
      if (!posix.isAbsolute(target) || posix.normalize(target) !== target || overlaps(target, INPUT_PROJECTION_TARGET))
        throw new Error("Workload mount overlaps immutable input projection.");
    }
    for (const mount of [...launch.mounts, ...launch.secrets])
      if (mount.source.kind === "host-path") this.publisher.assertMountSource(mount.source.path);
    const scope = { workspaceId: launch.workspace.id, projectionId: randomUUID() };
    const path = await this.publisher.prepare(scope);
    try {
      this.privateBackings = await probeDaemonHost(this.bin, await this.probeImage(), path, this.privateRoots);
    } catch (error) {
      await this.publisher.remove(scope);
      throw error;
    }
    return scope;
  }
  args(scope: ProjectionScope) {
    return [
      "--label",
      `${PROJECTION_LABEL}=${scope.projectionId}`,
      "--mount",
      `type=bind,src=${this.publisher.path(scope)},dst=${INPUT_PROJECTION_TARGET},readonly,bind-propagation=rprivate,bind-recursive=disabled`,
    ];
  }
  async inspect(ref: ProviderRef) {
    const scope = this.scope(ref);
    const [container] = JSON.parse(await runDocker(this.bin, ["inspect", ref.id]));
    const mounts = container.Mounts as {
      Type: string;
      Source: string;
      Destination: string;
      RW: boolean;
      Propagation: string;
    }[];
    const input = mounts.find((mount) => mount.Destination === INPUT_PROJECTION_TARGET);
    if (
      container.Id !== ref.id ||
      !input ||
      input.Type !== "bind" ||
      input.Source !== this.publisher.path(scope) ||
      input.RW ||
      input.Propagation !== "rprivate" ||
      mounts.some((mount) => mount !== input && overlaps(mount.Destination, INPUT_PROJECTION_TARGET)) ||
      container.Config.Labels[PROJECTION_LABEL] !== scope.projectionId ||
      container.Config.Labels["pocketcoder.workspace"] !== scope.workspaceId ||
      !container.HostConfig.ReadonlyRootfs ||
      container.HostConfig.Privileged ||
      container.HostConfig.CapAdd?.length ||
      !container.HostConfig.CapDrop?.includes("ALL")
    )
      throw new Error("Docker immutable input boundary does not match this incarnation.");
    for (const mount of mounts)
      if (mount !== input && mount.Type === "bind") this.publisher.assertMountSource(mount.Source);
    const path = this.publisher.path(scope);
    this.privateBackings ??= await probeDaemonHost(this.bin, await this.probeImage(), path, this.privateRoots);
    await verifyContainerInputBoundary(
      this.bin,
      await this.probeImage(),
      ref.id,
      this.publisher.path(scope),
      INPUT_PROJECTION_TARGET,
      this.privateBackings,
    );
    return { profile: "controller-readonly/v1" as const, identity: `docker:${ref.id}:${scope.projectionId}` };
  }
  async publish(ref: ProviderRef, input: InputProjectionRef) {
    await this.inspect(ref);
    return this.publisher.publish(this.scope(ref), ref.id, input);
  }
  async release(ref: ProviderRef, manifestId: string) {
    const scope = this.scope(ref);
    const [container] = JSON.parse(await runDocker(this.bin, ["inspect", ref.id]));
    if (
      container.Id !== ref.id ||
      container.Config.Labels[PROJECTION_LABEL] !== scope.projectionId ||
      container.Config.Labels["pocketcoder.workspace"] !== scope.workspaceId
    )
      throw new Error("Input projection cleanup incarnation mismatch.");
    await this.publisher.release(scope, manifestId);
  }
  async remove(ref: ProviderRef) {
    const remaining = await runDocker(this.bin, ["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${ref.id}`]);
    if (remaining) throw new Error("Input projection cleanup requires container removal.");
    await this.publisher.remove(this.scope(ref));
  }
  async discard(scope: ProjectionScope) {
    const remaining = await runDocker(this.bin, [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${PROJECTION_LABEL}=${scope.projectionId}`,
    ]);
    if (!remaining) await this.publisher.remove(scope);
  }
  async purge(workspaceId: string) {
    inputId(workspaceId);
    const remaining = await runDocker(this.bin, [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=pocketcoder.workspace=${workspaceId}`,
    ]);
    if (remaining) throw new Error("Input projection cleanup requires container removal.");
    await this.publisher.purge(workspaceId);
  }
}
