import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  inventoryAccountVolumes,
  type PhysicalInventory,
  type PhysicalStorage,
  removeAccountVolumes,
} from "@pstdio/pocketcoder-manager/purge";
import { createKubernetesCluster } from "./kubernetes-cluster";

type Command = (args: string[], input?: string) => Promise<string>;
type NodeIdentity = { name: string; uid: string; providerId: string; containerId: string };
type OwnedCluster = { kube: Command; run: Command; nodes: NodeIdentity[]; root: string };
type Handle = { claimUid: string; nodeUid: string; providerId: string; path: string };
const DRIVER = "kind-owned-hostpath";

export function createKindPurgeStorage(owned: OwnedCluster): PhysicalStorage {
  if (!owned.nodes.length || owned.root !== "/var/local-path-provisioner")
    throw new Error("Owned Kind storage root is missing");
  async function binding(handle: string) {
    const value = JSON.parse(handle) as Handle;
    if (
      typeof value.claimUid !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.claimUid) ||
      typeof value.path !== "string" ||
      posix.normalize(value.path) !== value.path ||
      !value.path.startsWith(`${owned.root}/`) ||
      value.path.slice(owned.root.length + 1).includes("/")
    )
      throw new Error("Owned Kind path differs");
    const node = owned.nodes.find((node) => node.uid === value.nodeUid && node.providerId === value.providerId);
    if (!node) throw new Error("Kind node is outside the owned fixture");
    const current = JSON.parse(await owned.kube(["get", "node", node.name, "-o", "json"]));
    if (
      current.metadata.uid !== node.uid ||
      current.spec.providerID !== node.providerId ||
      !current.status.conditions.some(
        (condition: { type: string; status: string }) => condition.type === "Ready" && condition.status === "True",
      )
    )
      throw new Error("Owned Kind node custody differs");
    const container = await owned.run(["docker", "inspect", "--format", "{{.Id}}", node.name]);
    if (container !== node.containerId) throw new Error("Owned Kind container differs");
    const probe = await owned.run([
      "docker",
      "exec",
      container,
      "sh",
      "-eu",
      "-c",
      'test ! -L "$1"; test "$(realpath -e "$1")" = "$1"; if test -e "$2" || test -L "$2"; then test ! -L "$2"; test -d "$2"; test "$(realpath -e "$2")" = "$2"; printf present; else printf absent; fi',
      "probe",
      owned.root,
      value.path,
    ]);
    return { value, node, container, present: probe === "present" };
  }
  function identity(input: PhysicalInventory) {
    if (input.provider !== DRIVER || input.snapshotIds.length) throw new Error("Owned Kind inventory differs");
    return input.volumeId;
  }
  return {
    async inventory(volume) {
      if (volume.driver !== DRIVER) throw new Error("Owned Kind adapter refuses this driver");
      const state = await binding(volume.handle);
      if (!state.present) throw new Error("Owned Kind volume bytes are missing");
      return { provider: DRIVER, volumeId: volume.handle, snapshotIds: [] };
    },
    async removeAndVerify(input) {
      const handle = identity(input);
      const state = await binding(handle);
      if (state.present) await owned.run(["docker", "exec", state.container, "rm", "-rf", "--", state.value.path]);
      if ((await binding(handle)).present) throw new Error("Owned Kind volume bytes remain");
      return { ...input, verifiedAt: new Date().toISOString() };
    },
    // Fixture accounts have no public hosts, so purge never reaches DNS here.
    async dnsRecords() {
      throw new Error("Owned Kind storage has no public DNS");
    },
    async dnsAbsent() {
      throw new Error("Owned Kind storage has no public DNS");
    },
  };
}

async function refuses(action: () => Promise<unknown>, message: string) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(message)) throw error;
    console.log(JSON.stringify({ refusal: message }));
    return true;
  }
  throw new Error("Unsafe volume operation was accepted");
}
function volumeFixture(cluster: { kube: Command; run: Command }, nodes: NodeIdentity[], root: string) {
  const apply = (resource: unknown) => cluster.kube(["create", "-f", "-"], JSON.stringify(resource));
  async function account() {
    const id = randomUUID();
    const namespace = `pc-account-${id.replaceAll("-", "")}`;
    const labels = { "pocketcoder.dev/account": id };
    await apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: namespace, labels } });
    const current = JSON.parse(await cluster.kube(["get", "namespace", namespace, "-o", "json"]));
    console.log(JSON.stringify({ accountIdentity: { accountId: id, namespaceUid: current.metadata.uid } }));
    return { id, namespace, labels };
  }
  async function volume(
    target: Awaited<ReturnType<typeof account>>,
    name: string,
    priorName?: string,
    sharedPath?: string,
  ) {
    const node = nodes[0];
    if (!node) throw new Error("Owned Kind node is missing");
    const pv = priorName ?? `pc-purge-${randomUUID()}`;
    const path = sharedPath ?? `${root}/${pv}`;
    await cluster.run([
      "docker",
      "exec",
      node.name,
      "sh",
      "-eu",
      "-c",
      'mkdir -p "$1"; printf retained > "$1/marker"',
      "create",
      path,
    ]);
    await apply({
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: pv },
      spec: {
        capacity: { storage: "1Mi" },
        accessModes: ["ReadWriteOnce"],
        persistentVolumeReclaimPolicy: "Delete",
        storageClassName: "",
        hostPath: { path, type: "Directory" },
        claimRef: { name, namespace: target.namespace },
        nodeAffinity: {
          required: {
            nodeSelectorTerms: [
              { matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [node.name] }] },
            ],
          },
        },
      },
    });
    await apply({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name, namespace: target.namespace, labels: target.labels },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: "",
        volumeName: pv,
        resources: { requests: { storage: "1Mi" } },
      },
    });
    await cluster.kube([
      "-n",
      target.namespace,
      "wait",
      `pvc/${name}`,
      "--for=jsonpath={.status.phase}=Bound",
      "--timeout=30s",
    ]);
    const claim = JSON.parse(await cluster.kube(["-n", target.namespace, "get", "pvc", name, "-o", "json"]));
    const persistent = JSON.parse(await cluster.kube(["get", "pv", pv, "-o", "json"]));
    const markerPresent = (await cluster.run(["docker", "exec", node.name, "cat", `${path}/marker`])) === "retained";
    console.log(
      JSON.stringify({
        bound: {
          accountId: target.id,
          claimUid: claim.metadata.uid,
          persistentVolumeUid: persistent.metadata.uid,
          nodeUid: node.uid,
          providerId: node.providerId,
          markerPresent,
        },
      }),
    );
    if (!markerPresent) throw new Error("Owned Kind marker is missing");
    return { pv, path, name, node };
  }
  return { apply, account, volume };
}
async function conformance() {
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGTERM", interrupt);
  const owned = await createKubernetesCluster();
  const checked =
    (command: Command): Command =>
    async (args, input) => {
      if (interrupted) throw new Error("Owned Kind conformance interrupted");
      const result = await command(args, input);
      if (interrupted) throw new Error("Owned Kind conformance interrupted");
      return result;
    };
  const cluster = { ...owned, kube: checked(owned.kube), run: checked(owned.run) };
  console.log(JSON.stringify({ ownedKind: { name: owned.name, directory: owned.directory } }));
  let result: Record<string, boolean> | undefined;
  try {
    const nodes: NodeIdentity[] = [];
    for (const name of cluster.nodes) {
      const node = JSON.parse(await cluster.kube(["get", "node", name, "-o", "json"]));
      const containerId = await cluster.run(["docker", "inspect", "--format", "{{.Id}}", name]);
      nodes.push({ name, uid: node.metadata.uid, providerId: node.spec.providerID, containerId });
    }
    console.log(JSON.stringify({ ownedNodeIdentities: nodes }));
    const root = "/var/local-path-provisioner";
    const config = JSON.parse(
      await cluster.kube(["-n", "local-path-storage", "get", "configmap", "local-path-config", "-o", "json"]),
    );
    const paths = JSON.parse(config.data["config.json"]).nodePathMap.flatMap(
      (entry: { paths: string[] }) => entry.paths,
    );
    if (!paths.length || paths.some((path: string) => path !== root)) throw new Error("Kind provisioner root differs");
    const storage = createKindPurgeStorage({ ...cluster, nodes, root });
    const { apply, account, volume } = volumeFixture(cluster, nodes, root);
    const target = await account();
    const other = await account();
    const empty = await account();
    await refuses(
      () => inventoryAccountVolumes(cluster.kube, empty, storage),
      "Account volume inventory is incomplete",
    );
    const first = await volume(target, "controller-data");
    await volume(target, "restored-data");
    const foreign = await volume(other, "controller-data");
    const duplicate = await account();
    const shared = await volume(duplicate, "controller-data");
    await volume(duplicate, "restored-data", undefined, shared.path);
    const duplicateStorageRefused = await refuses(
      () => inventoryAccountVolumes(cluster.kube, duplicate, storage),
      "Account volumes share physical storage",
    );
    const retained = await inventoryAccountVolumes(cluster.kube, target, storage);
    await apply({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "pending", namespace: target.namespace, labels: target.labels },
      spec: {
        suspend: true,
        template: {
          spec: { restartPolicy: "Never", containers: [{ name: "probe", image: "invalid.invalid/never-pulled" }] },
        },
      },
    });
    const currentComputeRefused = await refuses(
      () => removeAccountVolumes(cluster.kube, retained, storage),
      "Account compute remains",
    );
    await cluster.kube(["-n", target.namespace, "delete", "job", "pending", "--wait=true", "--timeout=30s"]);
    await apply({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "not-admitted", namespace: target.namespace, labels: target.labels },
      spec: {
        schedulingGates: [{ name: "pocketcoder.dev/purge-fixture" }],
        restartPolicy: "Never",
        containers: [{ name: "probe", image: "invalid.invalid/never-pulled" }],
      },
    });
    await refuses(() => inventoryAccountVolumes(cluster.kube, target, storage), "Account compute remains");
    await cluster.kube(["-n", target.namespace, "delete", "pod", "not-admitted", "--wait=true", "--timeout=30s"]);
    await volume(target, "late-data");
    const lateClaimRefused = await refuses(
      () => removeAccountVolumes(cluster.kube, retained, storage),
      "Account claim identity changed",
    );
    const finalInventory = await inventoryAccountVolumes(cluster.kube, target, storage);
    const receipts = await removeAccountVolumes(cluster.kube, finalInventory, storage);
    if (receipts.length !== 3) throw new Error("Physical receipts are missing");
    await cluster.run(["docker", "exec", first.node.name, "test", "!", "-e", first.path]);
    const otherAccountBytesPresent =
      (await cluster.run(["docker", "exec", foreign.node.name, "cat", `${foreign.path}/marker`])) === "retained";
    const again = await removeAccountVolumes(cluster.kube, finalInventory, storage);
    await cluster.kube(["delete", "namespace", target.namespace, "--wait=true", "--timeout=30s"]);
    const absentNamespaceRetryVerified =
      (await removeAccountVolumes(cluster.kube, finalInventory, storage)).length === 3;
    await apply({ apiVersion: "v1", kind: "Namespace", metadata: { name: target.namespace, labels: target.labels } });
    const replacementNamespaceRefused = await refuses(
      () => removeAccountVolumes(cluster.kube, finalInventory, storage),
      "Account namespace identity differs",
    );
    const replacement = await account();
    const replaced = await volume(replacement, "controller-data");
    const original = await inventoryAccountVolumes(cluster.kube, replacement, storage);
    await cluster.kube([
      "patch",
      "pv",
      replaced.pv,
      "--type=merge",
      "-p",
      '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}',
    ]);
    await cluster.kube(["-n", replacement.namespace, "delete", "pvc", replaced.name, "--wait=true", "--timeout=30s"]);
    await cluster.kube(["delete", "pv", replaced.pv, "--wait=true", "--timeout=30s"]);
    await volume(replacement, replaced.name);
    const replacementClaimRefused = await refuses(
      () => removeAccountVolumes(cluster.kube, original, storage),
      "Account claim identity changed",
    );
    const rebound = await volume(other, "rebound-data", replaced.pv);
    const retainedHandleRefused = await refuses(
      () => removeAccountVolumes(cluster.kube, original, storage),
      "Retained physical storage has another binding",
    );
    await cluster.run(["docker", "exec", rebound.node.name, "test", "-f", `${rebound.path}/marker`]);
    result = {
      retainedBytesRemoved: true,
      otherAccountBytesPresent,
      lateClaimRefused,
      replacementClaimRefused,
      retainedHandleRefused,
      replacementNamespaceRefused,
      absentNamespaceRetryVerified,
      duplicateStorageRefused,
      currentComputeRefused,
      retryVerified: again.length === 3,
    };
  } finally {
    try {
      await owned.close();
    } finally {
      process.off("SIGTERM", interrupt);
    }
  }
  console.log(JSON.stringify({ ...result, cleanup: true }));
}

if (import.meta.main && process.argv[2] === "--conformance") await conformance();
