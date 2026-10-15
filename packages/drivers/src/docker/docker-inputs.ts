import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { credentialMemoryPaths, WorkloadImageSchema } from "@pstdio/pocketcoder-contracts";
import type { InputProjectionRef, InputStorageDriver, ProviderRef, WorkspaceLaunch } from "@pstdio/pocketcoder-runtime-core";
import { FilesystemInputProjection, INPUT_PROJECTION_TARGET, type ProjectionScope } from "../filesystem/input-projection";
import { inputId, overlaps } from "../filesystem/projection-paths";
import { resolveDockerImage, runDocker } from "./docker-command";

export const PROJECTION_LABEL = "pocketcoder.input-projection";
export interface DockerInputProjectionOptions {
  root: string;
  storage: InputStorageDriver;
  privateRoots: string[];
  // Deployment-owned, pinned image with /bin/sh, cat and awk for the daemon-host probe.
  probeImage: string;
}

export class DockerInputs {
  private readonly publisher: FilesystemInputProjection;
  constructor(private readonly bin: string, private readonly options: DockerInputProjectionOptions, inputDir: string) {
    WorkloadImageSchema.parse(options.probeImage);
    this.publisher = new FilesystemInputProjection(options);
    this.publisher.assertMountSource(inputDir);
  }
  private scope(ref: ProviderRef): ProjectionScope {
    if (typeof ref.workspaceId !== "string" || typeof ref.inputProjectionId !== "string")
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
      if (posix.normalize(target) !== target || overlaps(target, INPUT_PROJECTION_TARGET))
        throw new Error("Workload mount overlaps immutable input projection.");
    }
    for (const mount of [...launch.mounts, ...launch.secrets])
      if (mount.source.kind === "host-path") this.publisher.assertMountSource(mount.source.path);
    const scope = { workspaceId: launch.workspace.id, projectionId: randomUUID() };
    const path = await this.publisher.prepare(scope);
    try { await this.probe(path); }
    catch (error) { await this.publisher.remove(scope); throw error; }
    return scope;
  }
  args(scope: ProjectionScope) {
    return ["--label", `${PROJECTION_LABEL}=${scope.projectionId}`, "--mount",
      `type=bind,src=${this.publisher.path(scope)},dst=${INPUT_PROJECTION_TARGET},readonly,bind-propagation=rprivate,bind-recursive=disabled`];
  }
  private async probe(path: string) {
    const token = randomUUID();
    const marker = join(path, ".probe");
    await writeFile(marker, token, { mode: 0o444, flag: "wx" });
    try {
      const result = await runDocker(this.bin, ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--mount", `type=bind,src=${path},dst=/projection,readonly,bind-propagation=rprivate`,
        "--entrypoint", "/bin/sh", await resolveDockerImage(this.bin, this.options.probeImage), "-eu", "-c",
        'test "$(awk \'$5 ~ /^\\/projection\\// { n++ } END { print n+0 }\' /proc/self/mountinfo)" = 0; cat /projection/.probe']);
      if (result !== token) throw new Error("Docker daemon-host input storage is unavailable.");
    } finally { await rm(marker, { force: true }); }
  }
  async inspect(ref: ProviderRef) {
    const scope = this.scope(ref);
    const [container] = JSON.parse(await runDocker(this.bin, ["inspect", ref.id]));
    const mounts = container.Mounts as { Type: string; Source: string; Destination: string; RW: boolean; Propagation: string }[];
    const input = mounts.find((mount) => mount.Destination === INPUT_PROJECTION_TARGET);
    if (!input || input.Type !== "bind" || input.Source !== this.publisher.path(scope) || input.RW || input.Propagation !== "rprivate" ||
      mounts.some((mount) => mount !== input && overlaps(mount.Destination, INPUT_PROJECTION_TARGET)) ||
      container.Config.Labels[PROJECTION_LABEL] !== scope.projectionId || container.Config.Labels["pocketcoder.workspace"] !== scope.workspaceId ||
      !container.HostConfig.ReadonlyRootfs || container.HostConfig.Privileged || !container.HostConfig.CapDrop?.includes("ALL"))
      throw new Error("Docker immutable input boundary does not match this incarnation.");
    for (const mount of mounts) if (mount !== input && mount.Type === "bind") this.publisher.assertMountSource(mount.Source);
    return { profile: "controller-readonly/v1" as const, identity: `docker:${ref.id}:${scope.projectionId}` };
  }
  async publish(ref: ProviderRef, input: InputProjectionRef) {
    await this.inspect(ref);
    return this.publisher.publish(this.scope(ref), ref.id, input);
  }
  async remove(ref: ProviderRef) {
    const remaining = await runDocker(this.bin, ["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${ref.id}`]);
    if (remaining) throw new Error("Input projection cleanup requires container removal.");
    await this.publisher.remove(this.scope(ref));
  }
}
