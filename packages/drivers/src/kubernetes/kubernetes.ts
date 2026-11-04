import { timeoutMs } from "@pstdio/pocketcoder-contracts";
import type {
  InputProjectionRef,
  InputStorageDriver,
  ProviderRef,
  ProviderState,
  WarmRuntimeLaunch,
  WorkspaceDriver,
  WorkspaceLaunch,
  WorkspaceRow,
} from "@pstdio/pocketcoder-runtime-core";
import { ProviderNotSubmittedError } from "@pstdio/pocketcoder-runtime-core";
import { type EgressDriverOptions, egressConfig, workspaceInput } from "../egress/egress";
import type { RegistryResolver } from "../registry/registry";
import { workloadReference } from "../workloads/workload-reference";
import { isKubernetesName, kubectl, resourceName } from "./kubernetes-command";
import { listWarmRuntimes, listWorkspaces } from "./kubernetes-discovery";
import {
  captureTermination,
  EVIDENCE_FINALIZER,
  readTerminationEvidence,
  releaseRetainedPods,
  retainNodeIdentities,
} from "./kubernetes-evidence";
import {
  deleteResource,
  jobUidOf,
  neverAdmittedInputUid,
  referencedJob,
  removeReferencedJob,
} from "./kubernetes-identity";
import { cleanupWarmInput, cleanupWorkspaceInput, purgeWorkspaceSecrets } from "./kubernetes-input-secrets";
import { jobState } from "./kubernetes-inspect";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";
import { legacyKubernetesProvider } from "./kubernetes-legacy";
import { workspaceJobManifest } from "./kubernetes-manifests";
import { applyRegistrySecret } from "./kubernetes-registry";
import {
  type KubernetesSchedulingOptions,
  type KubernetesToleration,
  validateToleration,
} from "./kubernetes-scheduling";
import type { KubernetesSharedStorage } from "./kubernetes-shared-storage";
import { stopKubernetesJob } from "./kubernetes-stop";
import {
  claimLaunchPhase,
  LAUNCH_PHASE,
  type LaunchMetadata,
  uncommittedKubernetesProvider,
  uncommittedKubernetesWorkspace,
} from "./kubernetes-uncommitted";
import { checkSharedStorage, prepareSharedLaunch } from "./kubernetes-volumes";
import { createKubernetesWarm } from "./kubernetes-warm";
import { KubernetesWorkloads } from "./kubernetes-workloads";

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
  sharedStorage?: KubernetesSharedStorage;
  // Canonical upload bytes that published executions copy from.
  inputSource?: InputStorageDriver;
}

export class KubernetesDriver implements WorkspaceDriver {
  readonly kind = "kubernetes";
  get inputStorageProfiles() {
    return this.sharedStorage ? (["shared-writer-readonly/v1"] as const) : ([] as const);
  }
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
  private readonly sharedStorage?: KubernetesSharedStorage;
  private readonly workloads: KubernetesWorkloads;
  private readonly kube = (args: string[], input?: string) => kubectl(this.kubectlBin, this.namespace, args, input);

  constructor(options: KubernetesDriverOptions = {}) {
    this.resolveRegistry = options.resolveRegistry;
    this.sharedStorage = options.sharedStorage;
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
    this.workloads = new KubernetesWorkloads(
      this.kube,
      {
        imagePullPolicy: this.imagePullPolicy,
        runtimeClassName: this.runtimeClassName,
        nodeSelector: this.nodeSelector,
        tolerations: this.tolerations,
      },
      { sharedStorage: this.sharedStorage, inputSource: options.inputSource },
    );
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

  checkSharedStorage() {
    return checkSharedStorage(this.sharedStorage, this.namespace, this.kube);
  }

  async create(request: WorkspaceLaunch): Promise<ProviderRef> {
    const prepared = prepareSharedLaunch(request, this.sharedStorage, this.namespace, this.kube);
    const { launch, storageIdentity, sharedMounts } = await prepared.catch((error) => {
      throw new ProviderNotSubmittedError(error);
    });
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
        sharedMounts,
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
      const ref = {
        kind: this.kind,
        ...workloadReference(workspace),
        id: name,
        jobUid: jobUidOf(job),
        ...(storageIdentity ? { storageIdentity, workspaceId: workspace.id } : {}),
        name,
        inputSecret,
        ...(spec.imagePullSecret ? { registrySecret } : {}),
        ...(restricted ? { egressSecret } : {}),
        namespace: this.namespace,
      };
      if (workspace.templateSnapshot.manifest)
        await this.workloads.waitUntilRunning(ref, timeoutMs(workspace.templateSnapshot, "start"));
      return ref;
    }
  }

  uncommittedProvider(workspace: Pick<WorkspaceRow, "id" | "templateDigest" | "registrationExpiresAt">, at: Date) {
    return uncommittedKubernetesWorkspace(this.kube, this.namespace, workspace, at);
  }

  uncommittedWarmProvider(runtime: { id: string; templateDigest: string }) {
    return uncommittedKubernetesProvider(
      (args) => kubectl(this.kubectlBin, this.namespace, args),
      this.namespace,
      runtime,
      true,
    );
  }

  legacyProvider(ref: ProviderRef, owner: { id: string; templateDigest: string }) {
    return legacyKubernetesProvider((args) => kubectl(this.kubectlBin, this.namespace, args), ref, owner);
  }

  async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
    if (this.sharedStorage) throw new Error("Shared storage requires a cold workspace allocation");
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

  publishInputs(ref: ProviderRef, input: InputProjectionRef) {
    return this.workloads.publish(ref, input);
  }

  releaseInputProjection(ref: ProviderRef, manifestId: string) {
    return this.workloads.release(ref, manifestId);
  }

  async inspect(ref: ProviderRef): Promise<ProviderState> {
    const run = (args: string[]) => kubectl(this.kubectlBin, this.namespace, args);
    const job = await referencedJob(run, ref);
    if (!job) return { exists: false, running: false, exitCode: null };
    if (this.captureEvidence) {
      if (!job.metadata?.uid) throw new Error("Termination evidence unavailable");
      await retainNodeIdentities(run, ref.id, job.metadata.uid);
    }
    const state = await jobState(run, job);
    if (state.running && ref.workloadTemplate) await this.workloads.observe(ref, state);
    return state;
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
    // stop() leaves Pods retained when their Job is already being deleted.
    if (this.captureEvidence && typeof ref.jobUid === "string" && ref.jobUid)
      await releaseRetainedPods(run, ref.id, ref.jobUid);
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
    await purgeWorkspaceSecrets(this.kube, workspaceId);
    if (this.sharedStorage) await this.sharedStorage.purgeInputs(workspaceId);
  }

  cleanupInput(workspaceId: string) {
    return cleanupWorkspaceInput(this.kube, workspaceId);
  }

  cleanupWarmInput(runtimeId: string) {
    return cleanupWarmInput(this.kube, runtimeId);
  }

  list() {
    return listWorkspaces(this.kube, this.kind, this.namespace);
  }

  listWarm() {
    return listWarmRuntimes(this.kube, this.kind, this.namespace);
  }
}
