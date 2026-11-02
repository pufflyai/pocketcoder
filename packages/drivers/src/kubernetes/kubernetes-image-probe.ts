import { randomUUID } from "node:crypto";
import { type KubernetesSchedulingOptions, schedulingFields } from "./kubernetes-scheduling";

const PROBE_TIMEOUT_MS = 120_000;
const KUBERNETES_PROBE_LABEL = "pocketcoder.dev/workload-probe";

export interface ImageProbeOptions extends KubernetesSchedulingOptions {
  imagePullPolicy: "Always" | "IfNotPresent" | "Never";
  uid: number;
  gid: number;
  nodeName?: string;
  pullSecret?: string;
}

type Run = (args: string[], input?: string) => Promise<string>;

// Reads image-owned bytes from a fresh container of the pinned image. The live
// workload never answers for itself, matching the Docker driver's evidence.
export async function runImageProbe(run: Run, image: string, command: string[], options: ImageProbeOptions) {
  const name = `pocketcoder-probe-${randomUUID()}`;
  await run(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name, labels: { [KUBERNETES_PROBE_LABEL]: "true" } },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        activeDeadlineSeconds: PROBE_TIMEOUT_MS / 1000,
        enableServiceLinks: false,
        ...schedulingFields(options),
        ...(options.nodeName ? { nodeName: options.nodeName } : {}),
        ...(options.pullSecret ? { imagePullSecrets: [{ name: options.pullSecret }] } : {}),
        // Same pod-level identity as the workspace, so namespace admission policies apply unchanged.
        securityContext: {
          runAsNonRoot: true,
          runAsUser: options.uid,
          runAsGroup: options.gid,
          fsGroup: options.gid,
          seccompProfile: { type: "RuntimeDefault" },
        },
        volumes: [{ name: "tmp", emptyDir: { sizeLimit: "1Mi" } }],
        containers: [
          {
            name: "probe",
            image,
            imagePullPolicy: options.imagePullPolicy,
            command,
            resources: {
              requests: { cpu: "50m", memory: "64Mi", "ephemeral-storage": "16Mi" },
              limits: { cpu: "200m", memory: "64Mi", "ephemeral-storage": "16Mi" },
            },
            securityContext: {
              runAsNonRoot: true,
              runAsUser: options.uid,
              runAsGroup: options.gid,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
          },
        ],
      },
    }),
  );
  try {
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pod = JSON.parse(await run(["get", "pod", name, "-o", "json"]));
      if (pod.status?.phase === "Succeeded") return await run(["logs", name, "-c", "probe"]);
      if (pod.status?.phase === "Failed") {
        const terminated = pod.status.containerStatuses?.[0]?.state?.terminated;
        throw new Error(`Workload image probe failed: ${terminated?.reason ?? pod.status.reason ?? "unknown"}`);
      }
      await Bun.sleep(250);
    }
    throw new Error("Workload image probe timed out");
  } finally {
    await run(["delete", "pod", name, "--ignore-not-found", "--wait=false"]).catch(() => {});
  }
}
