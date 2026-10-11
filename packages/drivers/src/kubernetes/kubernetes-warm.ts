import type { ProviderRef, WarmRuntimeLaunch } from "@pstdio/pocketcoder-runtime-core";
import { type EgressDriverOptions, egressConfig, poolInput } from "../egress/egress";
import type { KubernetesDriverOptions } from "./kubernetes";
import { kubectl } from "./kubernetes-command";
import { EVIDENCE_FINALIZER } from "./kubernetes-evidence";
import { jobUidOf } from "./kubernetes-identity";
import { KUBERNETES_DIGEST_ANNOTATION, KUBERNETES_POOL_LABEL } from "./kubernetes-labels";
import { warmJobManifest } from "./kubernetes-manifests";

import { claimLaunchPhase, LAUNCH_PHASE, type LaunchMetadata } from "./kubernetes-uncommitted";

type WarmOptions = Pick<
  KubernetesDriverOptions,
  "serviceAccountName" | "nodeSelector" | "tolerations" | "runtimeClassName"
> & {
  namespace: string;
  kubectlBin: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  captureEvidence: boolean;
  egress: EgressDriverOptions;
  requireNativeSidecars: () => Promise<void>;
};

export async function createKubernetesWarm(launch: WarmRuntimeLaunch, options: WarmOptions): Promise<ProviderRef> {
  const spec = launch.template.spec;
  const name = `pocketcoder-pool-${launch.runtimeId}`;
  const inputSecret = `${name}-input`;
  const restricted = spec.network.mode === "restricted";
  const egressSecret = `${name}-egress`;
  const receipt = JSON.parse(
    await kubectl(
      options.kubectlBin,
      options.namespace,
      ["create", "-f", "-", "-o", "json"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: inputSecret,
          labels: { [KUBERNETES_POOL_LABEL]: launch.runtimeId },
          annotations: { [LAUNCH_PHASE]: "prepared", [KUBERNETES_DIGEST_ANNOTATION]: launch.template.digest },
        },
        type: "Opaque",
        stringData: {
          "input.json": JSON.stringify(restricted ? poolInput(launch.input) : launch.input),
        },
      }),
    ),
  ) as { metadata: LaunchMetadata };
  if (options.runtimeClassName)
    await kubectl(options.kubectlBin, options.namespace, [
      "get",
      "runtimeclass",
      options.runtimeClassName,
      "-o",
      "name",
    ]);
  if (restricted) {
    await options.requireNativeSidecars();
    await kubectl(
      options.kubectlBin,
      options.namespace,
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: egressSecret, labels: { [KUBERNETES_POOL_LABEL]: launch.runtimeId } },
        type: "Opaque",
        stringData: {
          "egress.json": JSON.stringify(egressConfig(options.egress, launch.input, spec.network, launch.expiresAt)),
        },
      }),
    );
  }
  const manifest = warmJobManifest(launch, name, inputSecret, egressSecret, {
    serviceAccountName: options.serviceAccountName,
    runtimeClassName: options.runtimeClassName,
    nodeSelector: options.nodeSelector,
    tolerations: options.tolerations,
    imagePullPolicy: options.imagePullPolicy,
    ...(options.captureEvidence ? { podFinalizers: [EVIDENCE_FINALIZER] } : {}),
    egressImage: options.egress.egressImage,
  });
  await claimLaunchPhase(
    (args) => kubectl(options.kubectlBin, options.namespace, args),
    inputSecret,
    receipt.metadata,
    "submitting",
  );
  const job = JSON.parse(
    await kubectl(options.kubectlBin, options.namespace, ["create", "-f", "-", "-o", "json"], JSON.stringify(manifest)),
  );
  return {
    kind: "kubernetes",
    id: name,
    jobUid: jobUidOf(job),
    name,
    inputSecret,
    namespace: options.namespace,
    poolRuntimeId: launch.runtimeId,
    ...(restricted ? { egressSecret } : {}),
  };
}
