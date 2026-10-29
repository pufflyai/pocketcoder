import {
  hasMatchingKubernetesTermination,
  type KubernetesEvidenceResource,
  podHasStopped,
} from "@pstdio/pocketcoder-drivers";
import { z } from "zod";
import { type NodeIdentity, PodExit, PurgeDrain } from "../purge/physical-state";
import type { kube } from "./command";

type Node = z.infer<typeof NodeIdentity>;
const LiveNode = z.object({
  metadata: z.object({ uid: z.uuid(), deletionTimestamp: z.string().optional() }),
  spec: z.object({ providerID: z.string().min(1) }),
  status: z.object({ conditions: z.array(z.object({ type: z.string(), status: z.string() })) }),
});
function nodeIdentity(input: unknown) {
  const node = LiveNode.parse(input);
  if (
    node.metadata.deletionTimestamp ||
    !node.status.conditions.some((condition) => condition.type === "Ready" && condition.status === "True")
  )
    throw new Error("Account compute node is unavailable.");
  return { uid: node.metadata.uid, providerId: node.spec.providerID };
}
export async function podNode(command: typeof kube, pod: KubernetesEvidenceResource) {
  if (!pod.spec.nodeName) return null;
  return nodeIdentity(JSON.parse(await command(["get", "node", pod.spec.nodeName, "-o", "json"])));
}
export async function verifyPurgeNodes(command: typeof kube, identities: (Node | null)[]) {
  const nodes = z.object({ items: z.array(LiveNode) }).parse(JSON.parse(await command(["get", "nodes", "-o", "json"])));
  for (const identity of identities) {
    if (!identity) continue;
    const found = nodes.items.find((node) => node.metadata.uid === identity.uid);
    if (!found || nodeIdentity(found).providerId !== identity.providerId)
      throw new Error("Account compute placement changed.");
  }
}
export function purgePodExit(pod: KubernetesEvidenceResource, node: Node | null) {
  if (!podHasStopped(pod)) throw new Error("Account container termination is uncertain.");
  const statuses = [
    ...(pod.status?.containerStatuses ?? []),
    ...(pod.status?.initContainerStatuses ?? []),
    ...(pod.status?.ephemeralContainerStatuses ?? []),
  ];
  return PodExit.parse({
    uid: pod.metadata.uid,
    node,
    containers: statuses.map((status) => ({
      id: status.containerID,
      exitCode: status.state.terminated?.exitCode,
      finishedAt: status.state.terminated?.finishedAt,
    })),
  });
}
export function purgeRuntimeDrain(input: unknown, accountId: string, operationId: string) {
  const response = z
    .object({
      account_id: z.uuid(),
      operation_id: z.uuid(),
      operation_state: z.literal("succeeded"),
      keys_revoked_at: z.iso.datetime(),
      compute_proof: z.object({
        evidence: z.array(
          z.object({
            id: z.uuid(),
            kind: z.enum(["workspace", "warm"]),
            provider: z.string().nullable(),
            admitted: z.boolean(),
            ref: z.record(z.string(), z.unknown()).nullable(),
            termination: z.record(z.string(), z.unknown()).nullable(),
          }),
        ),
      }),
    })
    .parse(input);
  if (response.account_id !== accountId || response.operation_id !== operationId)
    throw new Error("Private purge identity differs.");
  const runtimes = response.compute_proof.evidence.map((runtime) => {
    if (runtime.provider !== "kubernetes" && runtime.admitted) throw new Error("Unknown account runtime provider.");
    const ref = runtime.ref as {
      jobUid?: string;
      neverAdmitted?: { inputUid: string; workspaceId: string; templateDigest: string };
    } | null;
    if (
      runtime.admitted &&
      (!ref || !runtime.termination || !hasMatchingKubernetesTermination(ref, runtime.termination))
    )
      throw new Error("Account runtime exit identity differs.");
    const pods = (runtime.termination?.pods ?? []) as KubernetesEvidenceResource[];
    const nodes = (runtime.termination?.nodes ?? {}) as Record<string, unknown>;
    return {
      id: runtime.id,
      kind: runtime.kind,
      admitted: runtime.admitted,
      jobUid: ref?.jobUid ?? null,
      inputUid: ref?.neverAdmitted?.inputUid ?? null,
      pods: pods.map((pod) => purgePodExit(pod, pod.spec.nodeName ? nodeIdentity(nodes[pod.spec.nodeName]) : null)),
    };
  });
  return PurgeDrain.parse({ accountId, operationId, keysRevokedAt: response.keys_revoked_at, runtimes });
}
