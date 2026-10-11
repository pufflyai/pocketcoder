import { DATABASE_WORK, STAGING_HEADROOM } from "@pstdio/pocketcoder-db/off-node";
import type { managedLifecycleFixture } from "./managed-lifecycle-fixture";

type Fixture = Awaited<ReturnType<typeof managedLifecycleFixture>>;

export async function lifecycleDiagnostic(fixture: Fixture, namespace: string, operationId: string) {
  await privateDiagnostic(fixture, namespace, [
    ["/v1/account", null],
    ["/v1/account/suspend", { request_id: operationId }],
  ]);
}

export async function recoveryDiagnostic(fixture: Fixture, namespace: string) {
  await privateDiagnostic(fixture, namespace, [
    ["/v1/backup/restoration", null],
    ["/v1/recovery", null],
    ["/v1/recovery/complete", {}],
  ]);
}

async function privateDiagnostic(fixture: Fixture, namespace: string, requests: [string, unknown][]) {
  const script = `const http=await import('node:http');
for(const [path,body] of JSON.parse(process.argv[1])) {
await new Promise((resolve,reject)=>{
const r=http.request({socketPath:'/private/pc_data/admin.sock',path,method:body?'POST':'GET',headers:{'content-type':'application/json'}},s=>{
let data='';s.on('data',v=>data+=v);s.on('end',()=>{console.log(JSON.stringify({path,status:s.statusCode,response:JSON.parse(data)}));resolve()})});
r.on('error',reject);r.end(body?JSON.stringify(body):undefined)})}`;
  console.error(
    await fixture.cluster.kube([
      "-n",
      namespace,
      "exec",
      "deployment/controller",
      "-c",
      "controller",
      "--",
      "bun",
      "-e",
      script,
      JSON.stringify(requests),
    ]),
  );
}

export async function requireKindStorage(cluster: Fixture["cluster"]) {
  console.log("Owned Kind storage after image loading, before account provisioning:");
  for (const node of cluster.nodes) {
    for (const flag of ["-Pk", "-Pi"]) {
      console.log(JSON.stringify({ measurement: { node, path: "/var/lib/containerd", flag } }));
      const output = await cluster.run(["docker", "exec", node, "df", flag, "/var/lib/containerd"]);
      console.log(output);
      const available = Number(output.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]);
      const minimum =
        flag === "-Pk"
          ? (STAGING_HEADROOM.bytes + DATABASE_WORK.bytes) / 1024
          : STAGING_HEADROOM.files + DATABASE_WORK.files;
      // Local-path PVCs share this filesystem; declared PVC capacity cannot supply missing disk space.
      if (!Number.isSafeInteger(available) || available < minimum)
        throw new Error(`Owned Kind filesystem lacks database work and staging headroom: ${node} ${flag} ${available}`);
    }
  }
}

// Capture the actual owned filesystem before finally removes the failed Kind nodes.
export async function managedDiagnostics(fixture: Fixture, namespace: string, operationId?: string) {
  if (operationId)
    console.error(JSON.stringify({ operation: await fixture.currentStore()?.getOperation(operationId) }));
  for (const args of [
    ["get", "pods", "-o", "wide"],
    ["get", "events", "--sort-by=.lastTimestamp"],
    ["logs", "deployment/controller", "-c", "controller", "--tail=25"],
    ["logs", "deployment/controller", "-c", "private-storage", "--tail=25"],
  ]) {
    try {
      console.error(await fixture.cluster.kube(["-n", namespace, ...args]));
    } catch (error) {
      console.error(error);
    }
  }
  await managedStorageDiagnostics(fixture, namespace);
}

export async function managedStorageDiagnostics(fixture: Fixture, namespace: string) {
  const pods = JSON.parse(await fixture.cluster.kube(["-n", namespace, "get", "pods", "-o", "json"]));
  const nodes = new Set<string>();
  for (const pod of pods.items) if (pod.spec.nodeName) nodes.add(pod.spec.nodeName);
  const paths = await ownedVolumePaths(fixture, namespace);
  for (const node of paths.keys()) nodes.add(node);
  for (const node of nodes) {
    if (!fixture.cluster.nodes.includes(node)) throw new Error("Diagnostic node is outside the owned cluster.");
    await readDisk(fixture, node, new Set(["/var/lib/containerd", ...(paths.get(node) ?? [])]));
  }
}

async function readDisk(fixture: Fixture, node: string, paths: Set<string>) {
  for (const flag of ["-Pk", "-Pi"]) {
    for (const path of paths) {
      try {
        console.error(JSON.stringify({ measurement: { node, path, flag } }));
        console.error(await fixture.cluster.run(["docker", "exec", node, "df", flag, path]));
      } catch (error) {
        console.error(error);
      }
    }
  }
}

async function ownedVolumePaths(fixture: Fixture, namespace: string) {
  const paths = new Map<string, Set<string>>();
  const volumes = JSON.parse(await fixture.cluster.kube(["-n", namespace, "get", "pvc", "-o", "json"]));
  for (const claim of volumes.items) {
    if (!claim.spec.volumeName) continue;
    const volume = JSON.parse(await fixture.cluster.kube(["get", "pv", claim.spec.volumeName, "-o", "json"]));
    if (volume.spec.claimRef?.namespace !== namespace || volume.spec.claimRef?.uid !== claim.metadata.uid)
      throw new Error("Owned diagnostic volume identity differs.");
    console.error(
      JSON.stringify({
        volume: {
          name: volume.metadata.name,
          uid: volume.metadata.uid,
          capacity: volume.spec.capacity,
          path: volume.spec.hostPath?.path,
        },
      }),
    );
    if (volume.spec.hostPath?.path) {
      const terms = volume.spec.nodeAffinity?.required?.nodeSelectorTerms ?? [];
      const placed = terms.flatMap(
        (term: { matchExpressions?: { key: string; operator: string; values: string[] }[] }) =>
          (term.matchExpressions ?? []).flatMap((expression) =>
            expression.key === "kubernetes.io/hostname" && expression.operator === "In" ? expression.values : [],
          ),
      );
      if (placed.length !== 1 || !fixture.cluster.nodes.includes(placed[0]))
        throw new Error("Owned diagnostic PVC node placement is uncertain.");
      const node = placed[0] as string;
      const local = paths.get(node) ?? new Set<string>();
      local.add(volume.spec.hostPath.path);
      paths.set(node, local);
    }
  }
  return paths;
}
