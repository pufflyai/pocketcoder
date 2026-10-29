import {
  canonicalJson,
  type InstalledWorkload,
  InstalledWorkloadSchema,
  parseWorkloadTemplate,
  WorkloadTemplateSnapshotSchema,
} from "@pstdio/pocketcoder-contracts";
import type {
  InputProjectionStorage,
  ProviderRef,
  ProviderState,
  WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import { resolveDockerImage, runDocker } from "./docker-command";
import { type Descriptor, descriptorSchema, qualifyAdapters } from "./docker-workload-policy";

export class DockerWorkloads {
  // Digest-pinned image bytes are immutable; live incarnation and mount evidence
  // are deliberately checked again on every inspection.
  private readonly images = new Map<string, Promise<Descriptor>>();
  constructor(private readonly docker: string) {}

  reference(workspace: WorkspaceRow) {
    const manifest = workspace.templateSnapshot.manifest;
    if (!manifest) return {};
    return {
      workloadTemplate: {
        format: manifest.apiVersion,
        name: workspace.templateName,
        version: workspace.templateVersion,
        digest: workspace.templateDigest,
        manifest,
      },
      workspaceId: workspace.id,
    };
  }

  private async image(image: string) {
    let pending = this.images.get(image);
    if (!pending) {
      pending = this.readImage(image);
      this.images.set(image, pending);
      pending.catch(() => this.images.delete(image));
    }
    return pending;
  }

  private async imageCommand(image: string, command: string, args: string[], liveId?: string) {
    return runDocker(this.docker, [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "64m",
      "--pids-limit",
      "32",
      ...(liveId ? ["--user", "0:0", "--cap-add", "SYS_PTRACE", "--pid", `container:${liveId}`] : []),
      "--entrypoint",
      command,
      await resolveDockerImage(this.docker, image),
      ...args,
    ]);
  }

  private async readImage(image: string) {
    const raw = await this.imageCommand(image, "cat", ["/opt/pocketcoder/workload.json"]);
    if (Buffer.byteLength(raw) > 65536) throw new Error("Installed workload descriptor exceeds 65536 bytes.");
    const value = descriptorSchema.parse(JSON.parse(raw));
    const entries = [value.runtime, ...Object.values(value.adapters)];
    for (const entry of entries) {
      if (!entry.command.includes(entry.artifact))
        throw new Error("Installed command does not name its measured artifact.");
      await this.imageCommand(image, "/bin/sh", [
        "-eu",
        "-c",
        'for p do test -f "$p"; test "$(readlink -f "$p")" = "$p"; done',
        "verify",
        entry.artifact,
      ]);
    }
    const measured = await this.imageCommand(
      image,
      "sha256sum",
      entries.map((entry) => entry.artifact),
    );
    const hashes = new Map(
      measured.split("\n").map((line) => {
        const split = line.indexOf("  ");
        return [line.slice(split + 2), `sha256:${line.slice(0, split)}`];
      }),
    );
    for (const entry of entries)
      if (hashes.get(entry.artifact) !== entry.digest)
        throw new Error("Installed workload artifact differs from its image descriptor.");
    return value;
  }

  async inspect(
    ref: ProviderRef,
    state: ProviderState,
    storage?: InputProjectionStorage,
  ): Promise<InstalledWorkload | undefined> {
    if (!ref.workloadTemplate || !state.running || !state.containerIdentity) return;
    const snapshot = WorkloadTemplateSnapshotSchema.parse(ref.workloadTemplate);
    const spec = parseWorkloadTemplate(snapshot.manifest).manifest.spec;
    const actual = JSON.parse(await runDocker(this.docker, ["inspect", "--format", "{{json .}}", ref.id]));
    const expectedImage = await runDocker(this.docker, [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      await resolveDockerImage(this.docker, spec.image),
    ]);
    if (
      actual.Image !== expectedImage ||
      !actual.HostConfig.ReadonlyRootfs ||
      !actual.HostConfig.CapDrop?.includes("ALL") ||
      actual.HostConfig.Privileged
    ) {
      throw new Error("Installed workload image or isolation differs from its declaration.");
    }
    const descriptor = await this.image(spec.image);
    if (
      canonicalJson({ digest: descriptor.runtime.digest, protocol: descriptor.runtime.protocol }) !==
      canonicalJson(spec.runtime)
    )
      throw new Error("Installed workload runtime pin differs from its declaration.");
    if (
      canonicalJson(actual.Config.Cmd) !== canonicalJson(descriptor.runtime.command) ||
      canonicalJson(actual.Config.Entrypoint ?? []) !== canonicalJson(descriptor.runtime.entrypoint)
    )
      throw new Error("Installed container startup differs from the image-owned runtime command.");
    const adapters = qualifyAdapters(spec, descriptor, actual.Mounts, storage);
    const live = await this.imageCommand(
      spec.image,
      "sha256sum",
      [descriptor.runtime, ...Object.values(descriptor.adapters)].map((entry) => `/proc/1/root${entry.artifact}`),
      ref.id,
    );
    for (const entry of [descriptor.runtime, ...Object.values(descriptor.adapters)]) {
      if (!live.includes(`${entry.digest.slice(7)}  /proc/1/root${entry.artifact}`))
        throw new Error("Live installed artifact differs from its image pin.");
    }
    if (!storage)
      throw new Error(
        `Canonical service workloads require qualified read-only input storage: ${state.detail ?? "not configured"}`,
      );
    return InstalledWorkloadSchema.parse({
      workspaceId: ref.workspaceId,
      incarnationId: state.containerIdentity,
      templateDigest: snapshot.digest,
      image: spec.image,
      runtime: spec.runtime,
      storage,
      capabilities: [
        ...new Set(["ready-without-task", ...Object.values(adapters).flatMap((adapter) => adapter.capabilities)]),
      ],
      adapters,
    });
  }
}
