import type { ProviderState } from "@pstdio/pocketcoder-runtime-core";
import type { Resource } from "./kubernetes-evidence-types";
import { jobUidOf, type KubernetesCommand } from "./kubernetes-identity";

// The Job controller reports a Pod the API server refused (admission policy, quota, Pod Security)
// only as a FailedCreate event on the Job. The Job itself stays active-less and condition-less.
async function podCreationRefused(run: KubernetesCommand, jobUid: string) {
  const output = await run([
    "get",
    "events",
    "--field-selector",
    `involvedObject.uid=${jobUid},reason=FailedCreate`,
    "-o",
    "json",
  ]);
  const events = JSON.parse(output) as { items?: unknown[] };
  return (events.items?.length ?? 0) > 0;
}

export async function jobState(run: KubernetesCommand, job: Resource): Promise<ProviderState> {
  const running = (job.status?.active ?? 0) > 0;
  if (running) return { exists: true, running, exitCode: null };
  if (job.status?.succeeded || job.status?.failed)
    return { exists: true, running, exitCode: job.status.succeeded ? 0 : 1 };
  if (await podCreationRefused(run, jobUidOf(job))) return { exists: true, running, exitCode: null, refused: true };
  return { exists: true, running, exitCode: null };
}
