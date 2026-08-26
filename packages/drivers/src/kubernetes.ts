import type {
  DiscoveredProvider,
  DiscoveredWarmProvider,
  ProviderRef,
  ProviderState,
  WarmRuntimeLaunch,
  WorkspaceDriver,
  WorkspaceLaunch,
} from "@pstdio/pocketcoder-runtime-core";
import { type EgressDriverOptions, egressConfig, poolInput, workspaceInput } from "./egress";
import { isKubernetesName, kubectl, resourceName } from "./kubernetes-command";
import { discoveredWarmRuntimes, discoveredWorkspaces } from "./kubernetes-discovery";
import { KUBERNETES_POOL_LABEL, KUBERNETES_WORKSPACE_LABEL } from "./kubernetes-labels";
import { warmJobManifest, workspaceJobManifest } from "./kubernetes-manifests";
import {
  type KubernetesSchedulingOptions,
  type KubernetesToleration,
  validateToleration,
} from "./kubernetes-scheduling";

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
}

export class KubernetesDriver implements WorkspaceDriver {
  readonly kind = "kubernetes";
  private readonly namespace: string;
  private readonly kubectlBin: string;
  private readonly serviceAccountName: string | undefined;
  private readonly nodeSelector: Record<string, string> | undefined;
  private readonly tolerations: KubernetesToleration[] | undefined;
  private readonly imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  private readonly egress: EgressDriverOptions;
  private sidecarsSupported = false;

  constructor(options: KubernetesDriverOptions = {}) {
    this.namespace = options.namespace ?? "default";
    if (!isKubernetesName(this.namespace)) {
      throw new Error("namespace must be a Kubernetes resource name");
    }
    this.kubectlBin = options.kubectlBin ?? "kubectl";
    this.serviceAccountName = options.serviceAccountName;
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
    if (restricted) await this.requireNativeSidecars();
    const egressSecret = `${name}-egress`;
    const inputManifest = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: inputSecret,
        labels: { [KUBERNETES_WORKSPACE_LABEL]: workspace.id },
      },
      type: "Opaque",
      stringData: { "input.json": JSON.stringify(restricted ? workspaceInput(input) : input) },
    };
    await kubectl(
      this.kubectlBin,
      this.namespace,
      ["apply", "-f", "-"],
      JSON.stringify(inputManifest),
    );
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
            "egress.json": JSON.stringify(
              egressConfig(this.egress, input, spec.network, workspace.deadlineAt),
            ),
          },
        }),
      );
    }

    const manifest = workspaceJobManifest(launch, name, inputSecret, egressSecret, {
      serviceAccountName: this.serviceAccountName,
      nodeSelector: this.nodeSelector,
      tolerations: this.tolerations,
      imagePullPolicy: this.imagePullPolicy,
      egressImage: this.egress.egressImage,
    });
    try {
      await kubectl(
        this.kubectlBin,
        this.namespace,
        ["apply", "-f", "-"],
        JSON.stringify(manifest),
      );
      return {
        kind: this.kind,
        id: name,
        name,
        inputSecret,
        ...(restricted ? { egressSecret } : {}),
        namespace: this.namespace,
      };
    } catch (error) {
      await kubectl(this.kubectlBin, this.namespace, [
        "delete",
        "secret",
        inputSecret,
        "--ignore-not-found",
      ]).catch(() => {});
      if (restricted) {
        await kubectl(this.kubectlBin, this.namespace, [
          "delete",
          "secret",
          egressSecret,
          "--ignore-not-found",
        ]).catch(() => {});
      }
      throw error;
    }
  }

  async createWarm(launch: WarmRuntimeLaunch): Promise<ProviderRef> {
    const spec = launch.template.spec;
    const name = `pocketcoder-pool-${launch.runtimeId}`;
    const inputSecret = `${name}-input`;
    const restricted = spec.network.mode === "restricted";
    if (restricted) await this.requireNativeSidecars();
    const egressSecret = `${name}-egress`;
    await kubectl(
      this.kubectlBin,
      this.namespace,
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: inputSecret, labels: { [KUBERNETES_POOL_LABEL]: launch.runtimeId } },
        type: "Opaque",
        stringData: {
          "input.json": JSON.stringify(restricted ? poolInput(launch.input) : launch.input),
        },
      }),
    );
    if (restricted) {
      await kubectl(
        this.kubectlBin,
        this.namespace,
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: egressSecret, labels: { [KUBERNETES_POOL_LABEL]: launch.runtimeId } },
          type: "Opaque",
          stringData: {
            "egress.json": JSON.stringify(
              egressConfig(this.egress, launch.input, spec.network, launch.expiresAt),
            ),
          },
        }),
      );
    }
    const manifest = warmJobManifest(launch, name, inputSecret, egressSecret, {
      serviceAccountName: this.serviceAccountName,
      nodeSelector: this.nodeSelector,
      tolerations: this.tolerations,
      imagePullPolicy: this.imagePullPolicy,
      egressImage: this.egress.egressImage,
    });
    try {
      await kubectl(
        this.kubectlBin,
        this.namespace,
        ["apply", "-f", "-"],
        JSON.stringify(manifest),
      );
      return {
        kind: this.kind,
        id: name,
        name,
        inputSecret,
        namespace: this.namespace,
        poolRuntimeId: launch.runtimeId,
        ...(restricted ? { egressSecret } : {}),
      };
    } catch (error) {
      await kubectl(this.kubectlBin, this.namespace, [
        "delete",
        "secret",
        inputSecret,
        "--ignore-not-found",
      ]).catch(() => {});
      if (restricted) {
        await kubectl(this.kubectlBin, this.namespace, [
          "delete",
          "secret",
          egressSecret,
          "--ignore-not-found",
        ]).catch(() => {});
      }
      throw error;
    }
  }

  async inspect(ref: ProviderRef): Promise<ProviderState> {
    try {
      const output = await kubectl(this.kubectlBin, this.namespace, [
        "get",
        "job",
        ref.id,
        "-o",
        "json",
      ]);
      const job = JSON.parse(output) as {
        status?: { active?: number; succeeded?: number; failed?: number };
      };
      const running = (job.status?.active ?? 0) > 0;
      return {
        exists: true,
        running,
        exitCode:
          running || !(job.status?.succeeded || job.status?.failed)
            ? null
            : job.status.succeeded
              ? 0
              : 1,
      };
    } catch {
      return { exists: false, running: false, exitCode: null };
    }
  }

  async stop(ref: ProviderRef, graceSeconds: number): Promise<void> {
    await kubectl(this.kubectlBin, this.namespace, [
      "patch",
      "job",
      ref.id,
      "--type=merge",
      "-p",
      '{"spec":{"suspend":true}}',
    ]).catch(() => {});
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "pod",
      "-l",
      `job-name=${ref.id}`,
      `--grace-period=${graceSeconds}`,
      "--wait=true",
      "--ignore-not-found",
    ]).catch(() => {});
  }

  async remove(ref: ProviderRef): Promise<void> {
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "job",
      ref.id,
      "--ignore-not-found",
      "--wait=true",
    ]).catch(() => {});
    const inputSecret = typeof ref.inputSecret === "string" ? ref.inputSecret : `${ref.id}-input`;
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "secret",
      inputSecret,
      "--ignore-not-found",
    ]).catch(() => {});
    if (typeof ref.egressSecret === "string") {
      await kubectl(this.kubectlBin, this.namespace, [
        "delete",
        "secret",
        ref.egressSecret,
        "--ignore-not-found",
      ]).catch(() => {});
    }
  }

  async cleanupInput(workspaceId: string): Promise<void> {
    await kubectl(this.kubectlBin, this.namespace, [
      "delete",
      "secret",
      `${resourceName(workspaceId)}-input`,
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
