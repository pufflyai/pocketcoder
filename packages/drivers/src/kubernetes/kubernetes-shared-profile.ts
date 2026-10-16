import { isIPv4 } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { canonicalJson } from "@pstdio/pocketcoder-contracts";
import { isKubernetesName } from "./kubernetes-command";

export interface KubernetesSharedStorageOptions {
  root: string;
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
  if (
    !options.storageCidrs.length ||
    options.storageCidrs.some((cidr) => !cidr.endsWith("/32") || !isIPv4(cidr.slice(0, -3)))
  )
    throw new Error("Shared storage requires explicit isolated IPv4 endpoints");
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
  if (volume.spec.nfs && !options.storageCidrs.includes(`${volume.spec.nfs.server}/32`))
    throw new Error("NFS endpoint is not isolated from workloads");
  return { claimUid: claim.metadata.uid, volumeUid: volume.metadata.uid };
}

async function requireStorageIsolation(
  options: KubernetesSharedStorageOptions,
  run: (args: string[]) => Promise<string>,
) {
  const policies = JSON.parse(await run(["get", "networkpolicies", "-o", "json"])).items;
  if (policies.length !== 1 || policies[0].metadata.name !== options.networkPolicyName)
    throw new Error("Shared storage requires its exclusive workload network policy");
  const expected = {
    podSelector: {},
    policyTypes: ["Egress"],
    egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: options.storageCidrs } }] }],
  };
  // Other policies are additive. An extra allow rule would reopen the storage
  // protocol even when the workload's filesystem mount remains read-only.
  const spec = policies[0].spec;
  if (
    canonicalJson(spec.podSelector) !== "{}" ||
    canonicalJson(spec.policyTypes) !== canonicalJson(expected.policyTypes) ||
    canonicalJson(spec.egress) !== canonicalJson(expected.egress)
  )
    throw new Error("Shared storage network policy does not isolate its storage endpoints");
}
