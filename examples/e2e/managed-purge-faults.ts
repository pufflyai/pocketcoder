import { posix } from "node:path";
import { waitFor } from "./local-process";

type Commands = { kube(args: string[]): Promise<string>; run(args: string[]): Promise<string> };
export type PurgeFaultNode = { name: string; uid: string; providerId: string; containerId: string };

async function currentNode(cluster: Commands, node: PurgeFaultNode) {
  const current = JSON.parse(await cluster.kube(["get", "node", node.name, "-o", "json"]));
  if (current.metadata.uid !== node.uid || current.spec.providerID !== node.providerId)
    throw new Error("Owned purge fault node identity changed.");
  return current;
}

async function currentContainer(cluster: Commands, node: PurgeFaultNode) {
  const [current] = JSON.parse(await cluster.run(["docker", "inspect", node.containerId]));
  if (current.Id !== node.containerId || current.Name !== `/${node.name}` || !current.State.Running)
    throw new Error("Owned purge fault container identity changed.");
  return current;
}

function ready(node: { status: { conditions: { type: string; status: string }[] } }) {
  return node.status.conditions.some((condition) => condition.type === "Ready" && condition.status === "True");
}

export async function pausePurgeNode(cluster: Commands, node: PurgeFaultNode) {
  const original = await currentNode(cluster, node);
  if ("node-role.kubernetes.io/control-plane" in original.metadata.labels)
    throw new Error("The purge fault must leave the owned Kubernetes API running.");
  if (!ready(original) || (await currentContainer(cluster, node)).State.Paused)
    throw new Error("Owned purge fault node must start ready and unpaused.");
  await cluster.run(["docker", "pause", node.containerId]);
  let restored = false;
  async function restore() {
    if (restored) return;
    const container = await currentContainer(cluster, node);
    if (container.State.Paused) await cluster.run(["docker", "unpause", node.containerId]);
    await waitFor(() => currentNode(cluster, node).then(ready), 120_000, "same owned purge node readiness");
    restored = true;
    console.log(JSON.stringify({ purgeFaultNodeReturned: node }));
  }
  try {
    if (!(await currentContainer(cluster, node)).State.Paused) throw new Error("Owned node did not pause.");
    await waitFor(async () => !ready(await currentNode(cluster, node)), 120_000, "owned purge node to become NotReady");
    console.log(JSON.stringify({ purgeFaultNodeOffline: node }));
    return { restore };
  } catch (error) {
    await restore();
    throw error;
  }
}

export async function holdPurgeVolume(cluster: Commands, node: PurgeFaultNode, path: string) {
  const root = "/var/local-path-provisioner/";
  if (posix.normalize(path) !== path || !path.startsWith(root) || !/^[A-Za-z0-9_-]+$/.test(path.slice(root.length)))
    throw new Error("Purge fault volume is outside the owned Kind storage root.");
  if (!ready(await currentNode(cluster, node)) || (await currentContainer(cluster, node)).State.Paused)
    throw new Error("Owned purge volume node is unavailable.");
  await cluster.run([
    "docker",
    "exec",
    node.containerId,
    "sh",
    "-eu",
    "-c",
    'command -v mountpoint >/dev/null; test ! -L "$1"; test "$(realpath -e "$1")" = "$1"; if mountpoint -q "$1"; then exit 1; fi; mount --bind "$1" "$1"; mountpoint -q "$1"',
    "owned-purge-volume",
    path,
  ]);
  console.log(JSON.stringify({ purgeFaultVolumeHeld: { node, path } }));
  let released = false;
  return {
    async release() {
      if (released) return;
      if ((await currentContainer(cluster, node)).State.Paused)
        throw new Error("Restore the owned purge node before releasing its volume.");
      await cluster.run(["docker", "exec", node.containerId, "umount", "--", path]);
      released = true;
      console.log(JSON.stringify({ purgeFaultVolumeReleased: { node, path } }));
    },
  };
}
