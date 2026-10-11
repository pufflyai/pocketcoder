import type { ProviderRef } from "@pstdio/pocketcoder-runtime-core";
import type { Resource } from "./kubernetes-evidence-types";

export type KubernetesCommand = (args: string[], input?: string) => Promise<string>;

export function jobUidOf(job: { metadata?: { uid?: string } }) {
  if (!job.metadata?.uid) throw new Error("Kubernetes Job identity unavailable");
  return job.metadata.uid;
}

export function neverAdmittedInputUid(ref: ProviderRef) {
  const evidence = ref.terminationEvidence as { neverAdmitted?: { inputUid?: unknown } } | undefined;
  const uid = evidence?.neverAdmitted?.inputUid;
  return typeof uid === "string" && uid ? uid : undefined;
}

export async function referencedJob(run: KubernetesCommand, ref: ProviderRef) {
  if ((typeof ref.jobUid !== "string" || !ref.jobUid) && !neverAdmittedInputUid(ref))
    throw new Error("Kubernetes Job identity unavailable");
  const output = await run(["get", "job", ref.id, "--ignore-not-found", "-o", "json"]);
  if (!output) return null;
  const job = JSON.parse(output) as Resource;
  if (typeof ref.jobUid !== "string" || jobUidOf(job) !== ref.jobUid) throw new Error("Termination provider changed");
  return job;
}

export async function deleteResource(
  run: KubernetesCommand,
  namespace: string,
  kind: "jobs" | "pods" | "secrets",
  name: string,
  uid: string,
  graceSeconds?: number,
) {
  const api = kind === "jobs" ? "/apis/batch/v1" : "/api/v1";
  const path = `${api}/namespaces/${namespace}/${kind}/${name}`;
  try {
    await run(
      ["delete", "--raw", path, "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "DeleteOptions",
        preconditions: { uid },
        propagationPolicy: "Foreground",
        ...(graceSeconds === undefined ? {} : { gracePeriodSeconds: graceSeconds }),
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Error from server (NotFound)")) throw error;
  }
}

export async function waitForDeletion(run: KubernetesCommand, kind: "job" | "pod", name: string, uid: string) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const output = await run(["get", kind, name, "--ignore-not-found", "-o", "json"]);
    if (!output) return;
    if (jobUidOf(JSON.parse(output)) !== uid) throw new Error("Termination provider changed");
    if (Date.now() >= deadline) throw new Error("Provider deletion unconfirmed");
    await Bun.sleep(100);
  }
}

export async function removeReferencedJob(run: KubernetesCommand, namespace: string, ref: ProviderRef) {
  const job = await referencedJob(run, ref);
  if (!job) return;
  const uid = jobUidOf(job);
  await deleteResource(run, namespace, "jobs", ref.id, uid);
  await waitForDeletion(run, "job", ref.id, uid);
}
