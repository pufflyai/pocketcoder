import { isIPv4 } from "node:net";
import { isAbsolute, posix, resolve } from "node:path";
import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import { isKubernetesName } from "./kubernetes-command";

export interface KubernetesSharedStorageOptions {
  root: string;
  // Directory inside the claim that `root` mounts; workloads mount the same directory.
  claimSubPath?: string;
  checkpointRoot: string;
  claimName: string;
  volumeName: string;
  storageClassName: string;
  networkPolicyName: string;
  storageCidrs: string[];
  profile: "shared-writer-readonly/v1";
  maxBytes: number;
  maxFiles: number;
}

export function validateSharedProfile(options: KubernetesSharedStorageOptions) {
  if (options.profile !== "shared-writer-readonly/v1") throw new Error("Unsupported shared storage profile");
  for (const name of [options.claimName, options.volumeName, options.storageClassName, options.networkPolicyName])
    if (!isKubernetesName(name)) throw new Error("Shared storage requires configured Kubernetes identities");
  for (const value of [options.maxBytes, options.maxFiles])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Shared storage requires explicit bounds");
  if (!isAbsolute(options.root) || resolve(options.root) === "/")
    throw new Error("Shared publisher root must be an absolute private mount");
  const sub = options.claimSubPath;
  if (
    sub !== undefined &&
    (posix.isAbsolute(sub) || posix.normalize(sub) !== sub || sub.startsWith("..") || sub === ".")
  )
    throw new Error("Shared claim sub-path must be a normalized relative directory");
  if (!options.storageCidrs.length || options.storageCidrs.some((cidr) => !ipv4Range(cidr)))
    throw new Error("Shared storage requires explicit isolated IPv4 endpoints or subnets");
}

interface VolumeRecord {
  metadata: { name: string; uid: string; deletionTimestamp?: string };
  spec: {
    accessModes?: string[];
    volumeMode?: string;
    storageClassName?: string;
    volumeName?: string;
    persistentVolumeReclaimPolicy?: string;
    claimRef?: { uid: string; namespace: string; name: string };
    hostPath?: unknown;
    local?: unknown;
    nfs?: { server: string };
  };
  status?: { phase?: string };
}

export async function requireSharedVolume(
  options: KubernetesSharedStorageOptions,
  namespace: string,
  run: (args: string[]) => Promise<string>,
) {
  await requireStorageIsolation(options, run);
  const claim: VolumeRecord = JSON.parse(await run(["get", "pvc", options.claimName, "-o", "json"]));
  const volume: VolumeRecord = JSON.parse(await run(["get", "pv", options.volumeName, "-o", "json"]));
  for (const resource of [claim, volume]) {
    if (
      resource.metadata.deletionTimestamp ||
      resource.status?.phase !== "Bound" ||
      resource.spec.volumeMode === "Block" ||
      resource.spec.storageClassName !== options.storageClassName ||
      !resource.spec.accessModes?.includes("ReadWriteMany")
    )
      throw new Error("Shared storage requires a bound qualified ReadWriteMany filesystem");
  }
  if (
    claim.spec.volumeName !== options.volumeName ||
    volume.spec.claimRef?.uid !== claim.metadata.uid ||
    volume.spec.claimRef?.namespace !== namespace ||
    volume.spec.claimRef?.name !== options.claimName ||
    volume.spec.persistentVolumeReclaimPolicy !== "Retain" ||
    volume.spec.hostPath ||
    volume.spec.local
  )
    throw new Error("Shared storage binding or retention does not match the configured profile");
  const server = volume.spec.nfs?.server;
  if (server && !options.storageCidrs.some((cidr) => covers(cidr, `${server}/32`)))
    throw new Error("NFS endpoint is not isolated from workloads");
  return { claimUid: claim.metadata.uid, volumeUid: volume.metadata.uid };
}

interface NetworkPolicy {
  metadata: { name: string };
  spec: {
    podSelector?: unknown;
    policyTypes?: string[];
    egress?: { to?: { ipBlock?: { cidr: string; except?: string[] } }[] }[];
  };
}

function ipv4Range(cidr: string) {
  const [address = "", bits = ""] = cidr.split("/");
  const prefix = Number(bits);
  if (!isIPv4(address) || !/^\d+$/.test(bits) || prefix < 1 || prefix > 32) return undefined;
  const value = address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
  const size = 2 ** (32 - prefix);
  const start = Math.floor(value / size) * size;
  return { start, end: start + size - 1 };
}
function covers(outer: string, inner: string) {
  const a = ipv4Range(outer);
  const b = ipv4Range(inner);
  return !!a && !!b && a.start <= b.start && b.end <= a.end;
}
function overlaps(left: string, right: string) {
  const a = ipv4Range(left);
  const b = ipv4Range(right);
  return !!a && !!b && a.start <= b.end && b.start <= a.end;
}

// Policies are additive allow lists. Storage stays private when every pod is
// egress-isolated and no rule can address a storage endpoint. Selector peers
// only reach pods, never the storage service's own addresses.
async function requireStorageIsolation(
  options: KubernetesSharedStorageOptions,
  run: (args: string[]) => Promise<string>,
) {
  const policies: NetworkPolicy[] = JSON.parse(await run(["get", "networkpolicies", "-o", "json"])).items;
  const egressTypes = (policy: NetworkPolicy) =>
    policy.spec.policyTypes ?? (policy.spec.egress ? ["Ingress", "Egress"] : ["Ingress"]);
  const isolating = policies.find((policy) => policy.metadata.name === options.networkPolicyName);
  if (
    !isolating ||
    canonicalJson(isolating.spec.podSelector ?? {}) !== "{}" ||
    !egressTypes(isolating).includes("Egress")
  )
    throw new Error("Shared storage requires its named policy to isolate egress for every workload");
  for (const policy of policies) {
    if (!egressTypes(policy).includes("Egress")) continue;
    for (const rule of policy.spec.egress ?? []) {
      const reachesStorage =
        !rule.to?.length ||
        rule.to.some(
          ({ ipBlock }) =>
            ipBlock &&
            options.storageCidrs.some(
              (storage) =>
                overlaps(ipBlock.cidr, storage) && !ipBlock.except?.some((excluded) => covers(excluded, storage)),
            ),
        );
      if (reachesStorage) throw new Error(`Network policy ${policy.metadata.name} lets workloads reach shared storage`);
    }
  }
}
