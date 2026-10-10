import { z } from "zod";
import type { Account } from "../database/store";
import { kube } from "../kubernetes/command";

const PodList = z.object({
  items: z.array(
    z.object({
      metadata: z.object({
        labels: z.record(z.string(), z.string()).default({}),
        deletionTimestamp: z.string().nullish(),
      }),
      status: z.object({
        phase: z.string(),
        containerStatuses: z.array(z.object({ name: z.string(), state: z.record(z.string(), z.unknown()) })).optional(),
      }),
    }),
  ),
});
const Claims = z.object({ claimed_warm_runtime_ids: z.array(z.uuid()) });

export function countUsagePods(input: unknown, claimedWarm: string[]) {
  const assigned = new Set(claimedWarm);
  let workspaces = 0;
  let warm = 0;
  for (const pod of PodList.parse(input).items) {
    if (pod.metadata.deletionTimestamp || pod.status.phase !== "Running") continue;
    if (!pod.status.containerStatuses?.some((container) => container.name === "workspace" && container.state.running))
      continue;
    const labels = pod.metadata.labels;
    if (labels["pocketcoder.workspace"]) workspaces++;
    else if (labels["pocketcoder.pool-runtime"]) {
      if (assigned.has(labels["pocketcoder.pool-runtime"])) workspaces++;
      else warm++;
    }
  }
  return { workspaces, warm };
}

export async function observeUsage(account: Account) {
  const exec = ["-n", account.namespace, "exec", "deployment/controller", "-c", "controller", "--"];
  const [pods, claims, volume] = await Promise.allSettled([
    kube(["-n", account.namespace, "get", "pods", "-o", "json"]),
    kube([
      ...exec,
      "bun",
      "-e",
      "const r=await fetch('http://localhost/v1/usage/warm-claims',{unix:'/private/pc_data/admin.sock',signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error('Usage inventory unavailable');console.log(await r.text())",
    ]),
    kube([...exec, "du", "-s", "-B1", "-x", "/private"]),
  ]);
  let counts: { workspaces: number | null; warm: number | null } = { workspaces: null, warm: null };
  let volumeBytes: number | null = null;
  if (pods.status === "fulfilled" && claims.status === "fulfilled") {
    try {
      counts = countUsagePods(JSON.parse(pods.value), Claims.parse(JSON.parse(claims.value)).claimed_warm_runtime_ids);
    } catch {
      /* An incomplete observation is a gap, including invalid provider responses. */
    }
  }
  if (volume.status === "fulfilled") {
    try {
      const match = /^(\d+)\s+\/private$/.exec(volume.value);
      volumeBytes = z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .parse(match ? Number(match[1]) : null);
    } catch {
      /* Storage failure does not discard a valid workspace observation. */
    }
  }
  return { ...counts, volumeBytes };
}
