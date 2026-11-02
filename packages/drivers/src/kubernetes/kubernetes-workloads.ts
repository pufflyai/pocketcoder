import {
  canonicalJson,
  INPUT_PROJECTION_TARGET,
  type InstalledWorkload,
  InstalledWorkloadSchema,
  parseWorkloadTemplate,
  WorkloadTemplateSnapshotSchema,
} from "@pstdio/pocketcoder-contracts";
import type {
  InputProjectionRef,
  InputProjectionStorage,
  InputStorageDriver,
  ProviderRef,
  ProviderState,
} from "@pstdio/pocketcoder-runtime-core";
import { type Descriptor, descriptorArtifacts, descriptorSchema, qualifyAdapters } from "../workloads/workload-policy";
import { type ImageProbeOptions, runImageProbe } from "./kubernetes-image-probe";
import type { KubernetesSharedStorage } from "./kubernetes-shared-storage";

type Run = (args: string[], input?: string) => Promise<string>;
interface Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  securityContext?: {
    readOnlyRootFilesystem?: boolean;
    privileged?: boolean;
    allowPrivilegeEscalation?: boolean;
    capabilities?: { drop?: string[]; add?: string[] };
  };
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean; subPath?: string }[];
}
export interface WorkspacePod {
  metadata: { uid: string; deletionTimestamp?: string; ownerReferences?: { uid: string }[] };
  spec: {
    nodeName?: string;
    containers: Container[];
    volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
  };
  status?: {
    phase?: string;
    containerStatuses?: { name: string; containerID?: string; state?: { running?: unknown } }[];
  };
}

const workspaceContainer = (pod: WorkspacePod) => pod.spec.containers.find((item) => item.name === "workspace");
const workspaceStatus = (pod: WorkspacePod) => pod.status?.containerStatuses?.find((item) => item.name === "workspace");

export function containerIdentity(pod: WorkspacePod) {
  const status = workspaceStatus(pod);
  if (!status?.state?.running || !status.containerID) return undefined;
  // A Job pod never restarts in place; a new pod or container ID is a new incarnation.
  return `${pod.metadata.uid}/${status.containerID}`;
}

export class KubernetesWorkloads {
  // Digest-pinned image bytes are immutable; pod evidence is checked again on every inspection.
  private readonly images = new Map<string, Promise<Descriptor>>();
  constructor(
    private readonly run: Run,
    private readonly probe: Omit<ImageProbeOptions, "uid" | "gid" | "nodeName" | "pullSecret">,
    private readonly inputs: { sharedStorage?: KubernetesSharedStorage; inputSource?: InputStorageDriver },
  ) {}

  publish(ref: ProviderRef, input: InputProjectionRef) {
    const { sharedStorage, inputSource } = this.inputs;
    if (!sharedStorage || !inputSource) throw new Error("Kubernetes shared input storage is not configured.");
    if (ref.workspaceId !== input.manifest.workspaceId)
      throw new Error("Input projection belongs to another workspace.");
    return sharedStorage.publishInputs(input, inputSource);
  }

  async release(ref: ProviderRef, manifestId: string) {
    if (!this.inputs.sharedStorage || typeof ref.workspaceId !== "string")
      throw new Error("Kubernetes shared input storage is not configured.");
    await this.inputs.sharedStorage.releaseInputs(ref.workspaceId, manifestId);
  }

  // Adds incarnation, storage and producer evidence to a running Job's state.
  async observe(ref: ProviderRef, state: ProviderState) {
    const pod = await this.pod(ref);
    state.containerIdentity = pod && containerIdentity(pod);
    if (!pod || !state.containerIdentity) return;
    const shared = this.inputs.sharedStorage;
    if (shared) {
      try {
        state.inputStorage = this.inputStorage(ref, pod, shared);
      } catch (error) {
        state.detail = String(error);
      }
    }
    state.workload = await this.inspect(ref, pod, state.inputStorage);
  }

  async pod(ref: ProviderRef): Promise<WorkspacePod | undefined> {
    const { items } = JSON.parse(await this.run(["get", "pods", "-l", `job-name=${ref.id}`, "-o", "json"])) as {
      items: WorkspacePod[];
    };
    return items.find(
      (pod) =>
        !pod.metadata.deletionTimestamp && pod.metadata.ownerReferences?.some((owner) => owner.uid === ref.jobUid),
    );
  }

  // Docker returns a started container; a Job pod first has to be scheduled and pulled.
  async waitUntilRunning(ref: ProviderRef, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pod = await this.pod(ref);
      if (pod && containerIdentity(pod)) return pod;
      if (pod?.status?.phase === "Failed" || pod?.status?.phase === "Succeeded")
        throw new Error("Workspace pod ended before it started");
      await Bun.sleep(500);
    }
    throw new Error("Workspace pod did not start before its start timeout");
  }

  inputStorage(ref: ProviderRef, pod: WorkspacePod, shared: KubernetesSharedStorage): InputProjectionStorage {
    const container = workspaceContainer(pod);
    const mount = container?.volumeMounts?.find((item) => item.mountPath === INPUT_PROJECTION_TARGET);
    const volume = pod.spec.volumes?.find((item) => item.name === mount?.name);
    const identity = ref.storageIdentity as { claimUid?: string } | undefined;
    if (
      !mount?.readOnly ||
      typeof ref.workspaceId !== "string" ||
      mount.subPath !== shared.inputSubPath(ref.workspaceId) ||
      volume?.persistentVolumeClaim?.claimName !== shared.options.claimName ||
      !identity?.claimUid
    )
      throw new Error("Immutable inputs are not mounted read-only from the shared claim");
    return { profile: "shared-writer-readonly/v1", identity: `kubernetes:${identity.claimUid}:${ref.workspaceId}` };
  }

  async inspect(ref: ProviderRef, pod: WorkspacePod, storage?: InputProjectionStorage): Promise<InstalledWorkload> {
    const snapshot = WorkloadTemplateSnapshotSchema.parse(ref.workloadTemplate);
    const spec = parseWorkloadTemplate(snapshot.manifest).manifest.spec;
    const container = workspaceContainer(pod);
    // The pinned reference is the evidence: containerd verifies pulled content
    // against its digest, while status.imageID differs between image import paths.
    if (
      !container ||
      container.image !== spec.image ||
      !container.securityContext?.readOnlyRootFilesystem ||
      !container.securityContext.capabilities?.drop?.includes("ALL") ||
      container.securityContext.capabilities.add?.length ||
      container.securityContext.privileged ||
      container.securityContext.allowPrivilegeEscalation !== false
    )
      throw new Error("Installed workload image or isolation differs from its declaration.");
    const descriptor = await this.image(spec.image, {
      uid: spec.security.uid,
      gid: spec.security.gid,
      ...(pod.spec.nodeName ? { nodeName: pod.spec.nodeName } : {}),
      ...(typeof ref.registrySecret === "string" ? { pullSecret: ref.registrySecret } : {}),
    });
    if (
      canonicalJson({ digest: descriptor.runtime.digest, protocol: descriptor.runtime.protocol }) !==
      canonicalJson(spec.runtime)
    )
      throw new Error("Installed workload runtime pin differs from its declaration.");
    // Without `command` the image-owned entrypoint runs, as with `docker run <image> <cmd>`.
    if (container.command || canonicalJson(container.args ?? []) !== canonicalJson(descriptor.runtime.command))
      throw new Error("Installed container startup differs from the image-owned runtime command.");
    const mounts = (container.volumeMounts ?? []).map((mount) => ({ Destination: mount.mountPath }));
    const adapters = qualifyAdapters(spec, descriptor, mounts, storage);
    if (!storage) throw new Error("Canonical service workloads require qualified read-only input storage");
    return InstalledWorkloadSchema.parse({
      workspaceId: ref.workspaceId,
      incarnationId: containerIdentity(pod),
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

  private image(image: string, options: Pick<ImageProbeOptions, "uid" | "gid" | "nodeName" | "pullSecret">) {
    let pending = this.images.get(image);
    if (!pending) {
      pending = this.readImage(image, { ...this.probe, ...options });
      this.images.set(image, pending);
      pending.catch(() => this.images.delete(image));
    }
    return pending;
  }

  private async readImage(image: string, options: ImageProbeOptions) {
    const raw = await runImageProbe(this.run, image, ["cat", "/opt/pocketcoder/workload.json"], options);
    if (Buffer.byteLength(raw) > 65536) throw new Error("Installed workload descriptor exceeds 65536 bytes.");
    const value = descriptorSchema.parse(JSON.parse(raw));
    const entries = descriptorArtifacts(value);
    for (const entry of entries)
      if (!entry.command.includes(entry.artifact))
        throw new Error("Installed command does not name its measured artifact.");
    const measured = await runImageProbe(
      this.run,
      image,
      [
        "/bin/sh",
        "-eu",
        "-c",
        'for p do test -f "$p"; test "$(readlink -f "$p")" = "$p"; done; sha256sum "$@"',
        "verify",
        ...entries.map((entry) => entry.artifact),
      ],
      options,
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
}
