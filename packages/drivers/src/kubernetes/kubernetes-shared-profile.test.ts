import { expect, test } from "bun:test";
import { type KubernetesSharedStorageOptions, requireSharedVolume } from "./kubernetes-shared-profile";

const options: KubernetesSharedStorageOptions = {
  root: "/shared",
  checkpointRoot: "/checkpoints",
  claimName: "shared",
  volumeName: "shared-pv",
  storageClassName: "qualified-nfs",
  networkPolicyName: "storage-isolation",
  storageCidrs: ["10.1.5.20/32"],
  profile: "shared-writer-readonly/v1",
  maxBytes: 1024,
  maxFiles: 8,
};
// Managed or off-cluster storage: pod and namespace selectors cannot address it.
const external = { ...options, storageOutsidePodNetwork: true };
const bound = {
  status: { phase: "Bound" },
  spec: { storageClassName: "qualified-nfs", accessModes: ["ReadWriteMany"] },
};
const claim = {
  metadata: { name: "shared", uid: "claim" },
  ...bound,
  spec: { ...bound.spec, volumeName: "shared-pv" },
};
const volume = {
  metadata: { name: "shared-pv", uid: "volume" },
  ...bound,
  spec: {
    ...bound.spec,
    persistentVolumeReclaimPolicy: "Retain",
    claimRef: { uid: "claim", namespace: "workspaces", name: "shared" },
    nfs: { server: "10.1.5.20" },
  },
};
const isolate = (name: string, egress: unknown[]) => ({
  metadata: { name },
  spec: { podSelector: {}, policyTypes: ["Egress"], egress },
});
const allow = (name: string, egress: unknown[]) => ({
  metadata: { name },
  spec: { podSelector: { matchExpressions: [{ key: "pocketcoder.workspace", operator: "Exists" }] }, egress },
});
const pods = (namespace: string) => ({
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": namespace } },
});
// Kubernetes command boundary: policy evaluation needs only the API objects.
const check = (policies: readonly unknown[], profile = options) =>
  requireSharedVolume(profile, "workspaces", async ([, kind]) => {
    if (kind === "networkpolicies") return JSON.stringify({ items: policies });
    return JSON.stringify(kind === "pvc" ? claim : volume);
  });

test.each([
  {
    name: "one policy that allows everything except storage",
    policies: [isolate("storage-isolation", [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.1.5.20/32"] } }] }])],
  },
  {
    name: "default deny with a selector-only allowlist",
    policies: [
      isolate("storage-isolation", []),
      allow("workspace-egress", [{ to: [pods("kube-system")], ports: [{ port: 53 }] }, { to: [pods("gateway")] }]),
    ],
  },
  {
    name: "an extra address range that excludes storage",
    policies: [
      isolate("storage-isolation", []),
      allow("bedrock", [{ to: [{ ipBlock: { cidr: "10.1.0.0/16", except: ["10.1.5.0/24"] } }] }]),
    ],
  },
])("accepts workload egress that cannot reach shared storage: $name", async ({ policies }) => {
  expect(await check(policies, external)).toEqual({ claimUid: "claim", volumeUid: "volume" });
});

test.each([
  { name: "no isolating policy", policies: [allow("workspace-egress", [{ to: [pods("gateway")] }])], error: "isolat" },
  {
    name: "a rule that allows every destination",
    policies: [isolate("storage-isolation", []), allow("open", [{ ports: [{ port: 443 }] }])],
    error: "open",
  },
  {
    name: "an address range that contains storage",
    policies: [isolate("storage-isolation", []), allow("vpc", [{ to: [{ ipBlock: { cidr: "10.1.0.0/16" } }] }])],
    error: "vpc",
  },
])("rejects workload egress that can reach shared storage: $name", async ({ policies, error }) => {
  await expect(check(policies)).rejects.toThrow(error);
});

test("accepts storage endpoints declared as the subnet that hosts them", async () => {
  const subnet = { ...external, storageCidrs: ["10.1.5.0/24"] };
  const policies = [isolate("storage-isolation", []), allow("dns", [{ to: [pods("kube-system")] }])];

  expect(await check(policies, subnet)).toEqual({ claimUid: "claim", volumeUid: "volume" });
  await expect(
    check([...policies, allow("vpc", [{ to: [{ ipBlock: { cidr: "10.1.5.128/25" } }] }])], subnet),
  ).rejects.toThrow("vpc");
});

test("rejects selector peers unless shared storage is declared outside the pod network", async () => {
  // An in-cluster NFS pod is reachable through any selector that matches it.
  const policies = [isolate("storage-isolation", []), allow("same-namespace", [{ to: [pods("workspaces")] }])];

  await expect(check(policies)).rejects.toThrow("same-namespace");
  expect(await check(policies, external)).toEqual({ claimUid: "claim", volumeUid: "volume" });
});
