import type { ProviderRef, WarmRuntimeLaunch } from "@pstdio/pocketcoder-runtime-core";
import { type EgressDriverOptions, egressConfig, poolInput } from "../egress/egress";
import type { KubernetesDriverOptions } from "./kubernetes";
import { kubectl } from "./kubernetes-command";
import { EVIDENCE_FINALIZER } from "./kubernetes-evidence";
import { KUBERNETES_POOL_LABEL } from "./kubernetes-labels";
import { warmJobManifest } from "./kubernetes-manifests";

type WarmOptions = Pick<KubernetesDriverOptions, "serviceAccountName" | "nodeSelector" | "tolerations"> & {
  namespace: string;
  kubectlBin: string;
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  captureEvidence: boolean;
  egress: EgressDriverOptions;
};

export async function createKubernetesWarm(launch: WarmRuntimeLaunch, options: WarmOptions): Promise<ProviderRef> {
  const spec = launch.template.spec;
  const name = `pocketcoder-pool-${launch.runtimeId}`;
  const inputSecret = `${name}-input`;
  const restricted = spec.network.mode === "restricted";
  const egressSecret = `${name}-egress`;
  await kubectl(
    options.kubectlBin,
    options.namespace,
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
    nodeSelector: options.nodeSelector,
    tolerations: options.tolerations,
    imagePullPolicy: options.imagePullPolicy,
    ...(options.captureEvidence ? { podFinalizers: [EVIDENCE_FINALIZER] } : {}),
    egressImage: options.egress.egressImage,
  });
  try {
    await kubectl(options.kubectlBin, options.namespace, ["apply", "-f", "-"], JSON.stringify(manifest));
    return {
      kind: "kubernetes",
      id: name,
      name,
      inputSecret,
      namespace: options.namespace,
      poolRuntimeId: launch.runtimeId,
      ...(restricted ? { egressSecret } : {}),
    };
  } catch (error) {
    await kubectl(options.kubectlBin, options.namespace, ["delete", "secret", inputSecret, "--ignore-not-found"]).catch(
      () => {},
    );
    if (restricted) {
      await kubectl(options.kubectlBin, options.namespace, [
        "delete",
        "secret",
        egressSecret,
        "--ignore-not-found",
      ]).catch(() => {});
    }
    throw error;
  }
}
