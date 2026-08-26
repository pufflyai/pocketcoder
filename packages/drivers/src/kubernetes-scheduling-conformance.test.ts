import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { KubernetesToleration } from "./kubernetes-scheduling";

const enabled =
  process.env.POCKETCODER_KUBERNETES_CONFORMANCE === "1" &&
  Boolean(process.env.POCKETCODER_KUBERNETES_NODE_SELECTOR) &&
  Boolean(process.env.POCKETCODER_KUBERNETES_TOLERATIONS);

function namespace() {
  return process.env.POCKETCODER_KUBERNETES_NAMESPACE ?? "default";
}

function conformanceImage() {
  const image = process.env.POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE;
  if (!image || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("POCKETCODER_KUBERNETES_CONFORMANCE_IMAGE must be pinned by digest");
  }
  return image;
}

function schedulingConfig() {
  return {
    nodeSelector: JSON.parse(process.env.POCKETCODER_KUBERNETES_NODE_SELECTOR as string) as Record<
      string,
      string
    >,
    tolerations: JSON.parse(
      process.env.POCKETCODER_KUBERNETES_TOLERATIONS as string,
    ) as KubernetesToleration[],
  };
}

async function kubectl(args: string[], input?: string) {
  const child = Bun.spawn(["kubectl", ...args], {
    ...(input ? { stdin: "pipe" } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || `kubectl exited ${exitCode}`);
  return stdout;
}

function jobManifest(name: string, includeTolerations: boolean) {
  const { nodeSelector, tolerations } = schedulingConfig();
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: namespace() },
    spec: {
      backoffLimit: 0,
      template: {
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          nodeSelector,
          ...(includeTolerations ? { tolerations } : {}),
          containers: [
            {
              name: "probe",
              image: conformanceImage(),
              command: ["sh", "-c", "echo scheduled"],
              resources: {
                requests: { "ephemeral-storage": "64Mi" },
                limits: { "ephemeral-storage": "64Mi" },
              },
            },
          ],
        },
      },
    },
  };
}

async function apply(manifest: unknown) {
  await kubectl(["-n", namespace(), "apply", "-f", "-"], JSON.stringify(manifest));
}

async function podForJob(name: string) {
  const output = await kubectl([
    "-n",
    namespace(),
    "get",
    "pods",
    "-l",
    `job-name=${name}`,
    "-o",
    "json",
  ]);
  const list = JSON.parse(output) as { items: Array<Record<string, unknown>> };
  return list.items[0];
}

async function waitForUnschedulable(name: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pod = (await podForJob(name)) as {
      spec?: { nodeName?: string };
      status?: { conditions?: Array<{ reason?: string; status?: string; type?: string }> };
    };
    const condition = pod?.status?.conditions?.find((item) => item.type === "PodScheduled");
    if (
      !pod?.spec?.nodeName &&
      condition?.status === "False" &&
      condition.reason === "Unschedulable"
    ) {
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error("the Job without a toleration did not become unschedulable");
}

async function deleteJob(name: string) {
  await kubectl(["-n", namespace(), "delete", "job", name, "--ignore-not-found", "--wait=false"]);
}

describe.skipIf(!enabled)("Kubernetes workspace scheduling conformance", () => {
  test("requires the taint toleration and preserves ephemeral storage", async () => {
    const suffix = randomUUID().slice(0, 8);
    const blockedName = `pocketcoder-scheduling-blocked-${suffix}`;
    const scheduledName = `pocketcoder-scheduling-${suffix}`;
    try {
      await apply(jobManifest(blockedName, false));
      await waitForUnschedulable(blockedName);

      await apply(jobManifest(scheduledName, true));
      await kubectl([
        "-n",
        namespace(),
        "wait",
        `job/${scheduledName}`,
        "--for=condition=complete",
        "--timeout=120s",
      ]);
      const pod = (await podForJob(scheduledName)) as {
        spec: {
          nodeName: string;
          containers: Array<{ resources: Record<string, Record<string, string>> }>;
        };
      };
      const node = JSON.parse(await kubectl(["get", "node", pod.spec.nodeName, "-o", "json"])) as {
        metadata: { labels: Record<string, string> };
      };
      expect(node.metadata.labels).toMatchObject(schedulingConfig().nodeSelector);
      expect(pod.spec.containers[0]?.resources).toMatchObject({
        requests: { "ephemeral-storage": "64Mi" },
        limits: { "ephemeral-storage": "64Mi" },
      });
    } finally {
      await Promise.all([deleteJob(blockedName), deleteJob(scheduledName)]);
    }
  }, 180_000);
});
