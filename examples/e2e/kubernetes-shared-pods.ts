import { strict as assert } from "node:assert";
import type { ProviderRef } from "@pstdio/pocketcoder-runtime-core";

export const sharedNamespace = "pc-shared";

export async function kube(args: string[], timeoutMs = 30_000) {
  const proc = Bun.spawn(["kubectl", "-n", sharedNamespace, `--request-timeout=${timeoutMs}ms`, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(error);
  return output.trim();
}

type ProbePod = {
  metadata: { name: string; deletionTimestamp?: string };
  spec: {
    nodeName?: string;
    runtimeClassName?: string;
    automountServiceAccountToken?: boolean;
    initContainers?: unknown[];
  };
  status?: { conditions?: { type: string; status: string }[] };
};

export async function waitForWorkspacePod(ref: ProviderRef) {
  assert.ok(ref.jobUid, "The workspace launch must return its Job UID");
  const selector = `batch.kubernetes.io/controller-uid=${ref.jobUid}`;
  const deadline = Date.now() + 30_000;
  // The controller can list Pods but cannot watch them. Keep the same readiness deadline.
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const { items } = JSON.parse(await kube(["get", "pods", "-l", selector, "-o", "json"], remaining)) as {
      items: ProbePod[];
    };
    if (Date.now() >= deadline) break;
    const ready = items.find(
      (candidate) =>
        !candidate.metadata.deletionTimestamp &&
        candidate.status?.conditions?.some((condition) => condition.type === "Ready" && condition.status === "True"),
    );
    if (ready) return ready;
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for a ready Pod from Job ${ref.id}`);
}

export async function runInPod(podName: string, code: string) {
  return kube(["exec", podName, "--", "bun", "-e", code]);
}
