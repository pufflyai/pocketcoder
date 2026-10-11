import type {
  DiscoveredProvider,
  DiscoveredWarmProvider,
  ProviderRef,
  ProviderState,
  WarmRuntimeLaunch,
  WorkspaceDriver,
  WorkspaceLaunch,
  WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import { type EgressDriverOptions, egressConfig, workspaceInput } from "../egress/egress";
import type { RegistryResolver } from "../registry/registry";
import { isKubernetesName, kubectl, resourceName } from "./kubernetes-command";
import { discoveredWarmRuntimes, discoveredWorkspaces } from "./kubernetes-discovery";
import {
  captureTermination,
  EVIDENCE_FINALIZER,
  readTerminationEvidence,
  retainNodeIdentities,
} from "./kubernetes-evidence";
import {
  deleteResource,
  jobUidOf,
  neverAdmittedInputUid,
  referencedJob,
  removeReferencedJob,
} from "./kubernetes-identity";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";
import { workspaceJobManifest } from "./kubernetes-manifests";
import { applyRegistrySecret } from "./kubernetes-registry";
import {
  type KubernetesSchedulingOptions,
  type KubernetesToleration,
  validateToleration,
} from "./kubernetes-scheduling";
import { stopKubernetesJob } from "./kubernetes-stop";
import {
  claimLaunchPhase,
  LAUNCH_PHASE,
  type LaunchMetadata,
  uncommittedKubernetesProvider,
} from "./kubernetes-uncommitted";
import { createKubernetesWarm } from "./kubernetes-warm";

export {
  KUBERNETES_DIGEST_ANNOTATION,
  KUBERNETES_POOL_LABEL,
  KUBERNETES_WORKSPACE_LABEL,
} from "./kubernetes-labels";

export interface KubernetesDriverOptions extends EgressDriverOptions, KubernetesSchedulingOptions {
  namespace?: string;
  kubectlBin?: string;
  serviceAccountName?: string;
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  captureTerminationEvidence?: boolean;
  resolveRegistry?: RegistryResolver;
}

export class KubernetesDriver implements WorkspaceDriver {
  readonly kind = "kubernetes";
  private readonly namespace: string;
  private readonly kubectlBin: string;
  private readonly serviceAccountName: string | undefined;
  private readonly runtimeClassName: string | undefined;
  private readonly nodeSelector: Record<string, string> | undefined;
  private readonly tolerations: KubernetesToleration[] | undefined;
  private readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  private readonly egress: EgressDriverOptions;
  private sidecarsSupported = false;
  private readonly captureEvidence: boolean;
  private readonly resolveRegistry?: RegistryResolver;

  constructor(options: KubernetesDriverOptions = {}) {
    this.resolveRegistry = options.resolveRegistry;
    this.captureEvidence = options.captureTerminationEvidence ?? false;
    this.namespace = options.namespace ?? "default";
    if (!isKubernetesName(this.namespace)) {
      throw new Error("namespace must be a Kubernetes resource name");
    }
    this.kubectlBin = options.kubectlBin ?? "kubectl";
    this.serviceAccountName = options.serviceAccountName;
    this.runtimeClassName = options.runtimeClassName;
    if (this.runtimeClassName !== undefined && !isKubernetesName(this.runtimeClassName)) {
      throw new Error("runtimeClassName must be a Kubernetes resource name");
    }
    if (this.serviceAccountName && !isKubernetesName(this.serviceAccountName)) {
      throw new Error("serviceAccountName must be a Kubernetes resource name");
    }
    this.nodeSelector = options.nodeSelector;
    this.tolerations = options.tolerations;
    for (const toleration of this.tolerations ?? []) validateToleration(toleration);
    this.imagePullPolicy = options.imagePullPolicy ?? "IfNotPresent";
    this.egress = {
      ...(options.egressImage ? { egressImage: options.egressImage } : {}),
      ...(options.egressSigningKey ? { egressSigningKey: options.egressSigningKey } : {}),
    };
  }

  private async requireNativeSidecars() {
    if (this.sidecarsSupported) return;
    const output = await kubectl(this.kubectlBin, this.namespace, ["version", "-o", "json"]);
    const version = JSON.parse(output) as { serverVersion?: { major?: string; minor?: string } };
    const major = Number(version.serverVersion?.major ?? 0);
    const minor = Number((version.serverVersion?.minor ?? "0").replace(/\D.*$/, ""));
    if (major < 1 || (major === 1 && minor < 29)) {
      throw new Error("restricted workspaces require Kubernetes 1.29+ with SidecarContainers");
    }
    this.sidecarsSupported = true;
  }

  async create(launch: WorkspaceLaunch): Promise<ProviderRef> {
    const { workspace, input } = launch;
    const spec = workspace.templateSnapshot.spec;
    const name = resourceName(workspace.id);
    const inputSecret = `${name}-input`;
    const restricted = spec.network.mode === "restricted";
    const egressSecret = `${name}-egress`;
    const registrySecret = `${name}-registry`;
    {
      const inputManifest = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: inputSecret,
          labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id },
          annotations: { [LAUNCH_PHASE]: "prepared", [KUBERNETES_DIGEST_ANNOTATION]: workspace.templateDigest },
        },
        type: "Opaque",
        stringData: { "input.json": JSON.stringify(restricted ? workspaceInput(input) : input) },
      };
      const receipt = JSON.parse(
        await kubectl(
          this.kubectlBin,
          this.namespace,
          ["create", "-f", "-", "-o", "json"],
          JSON.stringify(inputManifest),
        ),
      ) as { metadata: LaunchMetadata };
      if (spec.imagePullSecret) {
        if (!this.resolveRegistry) throw new Error("Stored registry credentials are unavailable");
        await applyRegistrySecret(
          this.kubectlBin,
          this.namespace,
          registrySecret,
          workspace.id,
          await this.resolveRegistry(spec.imagePullSecret, spec.image),
        );
      }

      if (this.runtimeClassName)
        await kubectl(this.kubectlBin, this.namespace, ["get", "runtimeclass", this.runtimeClassName, "-o", "name"]);
      if (restricted) await this.requireNativeSidecars();
      if (restricted) {
        await kubectl(
          this.kubectlBin,
          this.namespace,
          ["apply", "-f", "-"],
          JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: egressSecret, labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id } },
            type: "Opaque",
            stringData: {
              "egress.json": JSON.stringify(egressConfig(this.egress, input, spec.network, workspace.deadlineAt)),
            },
          }),
        );
      }

      const manifest = workspaceJobManifest(launch, name, inputSecret, egressSecret, {
        serviceAccountName: this.serviceAccountName,
        runtimeClassName: this.runtimeClassName,
        nodeSelector: this.nodeSelector,
        tolerations: this.tolerations,
        imagePullPolicy: this.imagePullPolicy,
        ...(spec.imagePullSecret ? { imagePullSecret: registrySecret } : {}),
        ...(this.captureEvidence ? { podFinalizers: [EVIDENCE_FINALIZER] } : {}),
        egressImage: this.egress.egressImage,
      });
      await claimLaunchPhase(
        (args) => kubectl(this.kubectlBin, this.namespace, args),
        inputSecret,
        receipt.metadata,
        "submitting",
      );
      const job = JSON.parse(
        await kubectl(this.kubectlBin, this.namespace, ["create", "-f", "-", "-o", "json"], JSON.stringify(manifest)),
      );
      return {
        kind: this.kind,
        id: name,
        jobUid: jobUidOf(job),
        name,
        inputSecret,
        ...(spec.imagePullSecret ? { registrySecret } : {}),
        ...(restricted ? { egressSecret } : {}),
        namespace: this.namespace,
      };
    }
  }

  uncommittedProvider(workspace: Pick<WorkspaceRow, "id" | "templateDigest">) {
    return uncommittedKubernetesProvider(
      (args) => kubectl(this.kubectlBin, this.namespace, args),
      this.namespace,
      workspace,
    );
  }

  uncommittedWarmProvider(runtime: { id: string; templateDigest: string }) {
    return uncommittedKubernetesProvider(
      (args) => kubectl(this.kubectlBin, this.namespace, args),
      this.namespace,
      runtime,
      true,
    );
  }

  async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
    if (launch.template.spec.imagePullSecret) throw new Error("Private images cannot use warm pools");
    return createKubernetesWarm(launch, {
      namespace: this.namespace,
      kubectlBin: this.kubectlBin,
      serviceAccountName: this.serviceAccountName,
      runtimeClassName: this.runtimeClassName,
      nodeSelector: this.nodeSelector,
      tolerations: this.tolerations,
      imagePullPolicy: this.imagePullPolicy,
      requireNativeSidecars: () => this.requireNativeSidecars(),
      captureEvidence: this.captureEvidence,
      egress: this.egress,
    });
  }

  async inspect(ref: ProviderRef): Promise<ProviderState> {
    const job = await referencedJob((args) => kubectl(this.kubectlBin, this.namespace, args), ref);
    if (!job) return { exists: false, running: false, exitCode: null };
    if (this.captureEvidence) {
      if (!job.metadata?.uid) throw new Error("Termination evidence unavailable");
      await retainNodeIdentities((args) => kubectl(this.kubectlBin, this.namespace, args), ref.id, job.metadata.uid);
    }
    const running = (job.status?.active ?? 0) > 0;
    const completedExitCode = job.status?.succeeded ? 0 : 1;
    return {
      exists: true,
      running,
      exitCode: running || !(job.status?.succeeded || job.status?.failed) ? null : completedExitCode,
    };
  }

  async stop(ref: ProviderRef, graceSeconds: number): Promise<void> {
    const run = (args: string[], input?: string) => kubectl(this.kubectlBin, this.namespace, args, input);
    if (!ref.jobUid && neverAdmittedInputUid(ref)) {
      await referencedJob(run, ref);
      return;
    }
    if (typeof ref.jobUid !== "string" || !ref.jobUid) throw new Error("Kubernetes Job identity unavailable");
    if (this.captureEvidence) {
      await captureTermination(run, ref.id, graceSeconds, ref.jobUid, this.namespace);
      return;
    }
    await stopKubernetesJob(run, this.namespace, ref, graceSeconds);
  }

  async remove(ref: ProviderRef): Promise<void> {
    const run = (args: string[], input?: string) => kubectl(this.kubectlBin, this.namespace, args, input);
    await removeReferencedJob(run, this.namespace, ref);
    await kubectl(this.kubectlBin, this.namespace, ["delete", "secret", `${ref.id}-registry`, "--ignore-not-found"]);
    const inputSecret = typeof ref.inputSecret === "string" ? ref.inputSecret : `${ref.id}-input`;
    const inputUid = neverAdmittedInputUid(ref);
    if (inputUid) await deleteResource(run, this.namespace, "secrets", inputSecret, inputUid);
    else await run(["delete", "secret", inputSecret, "--ignore-not-found"]);
    if (typeof ref.egressSecret === "string") {
      await kubectl(this.kubectlBin, this.namespace, ["delete", "secret", ref.egressSecret, "--ignore-not-found"]);
    }
  }

  async terminationEvidence(ref: ProviderRef): Promise<Record<string, unknown> | null> {
    const run = (args: string[]) => kubectl(this.kubectlBin, this.namespace, args);
    await referencedJob(run, ref);
    if (!ref.jobUid && neverAdmittedInputUid(ref)) return ref.terminationEvidence as Record<string, unknown>;
    if (!this.captureEvidence) return null;
    return readTerminationEvidence(run, ref.id, ref.jobUid as string);
  }

  async purgeInput(workspaceId: string): Promise<void> {
    const name = resourceName(workspaceId);
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "secret",
      `${name}-input`,
      `${name}-egress`,
      `${name}-registry`,
      "--ignore-not-found",
      "--wait=true",
    ]);
  }

  async cleanupInput(workspaceId: string): Promise<void> {
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "secret",
      `${resourceName(workspaceId)}-input`,
      `${resourceName(workspaceId)}-registry`,
      "--ignore-not-found",
    ]).catch(() => {});
  }

  async cleanupWarmInput(runtimeId: string): Promise<void> {
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "secret",
      `pocketcoder-pool-${runtimeId}-input`,
      "--ignore-not-found",
    ]).catch(() => {});
  }

  async list(): Promise<DiscoveredProvider[]> {
    const output = await kubectl(this.kubectlBin, this.namespace, [
      "get",
      "jobs",
      "-l",
      KUBERNETES_WORKSPACE_LABEL,
      "-o",
      "json",
    ]);
    return discoveredWorkspaces(output, this.kind, this.namespace);
  }

  async listWarm(): Promise<DiscoveredWarmProvider[]> {
    const output = await kubectl(this.kubectlBin, this.namespace, [
      "get",
      "jobs",
      "-l",
      KUBERNETES_POOL_LABEL,
      "-o",
      "json",
    ]);
    return discoveredWarmRuntimes(output, this.kind, this.namespace);
  }
}
