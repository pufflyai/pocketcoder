import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { controllerKubeconfig } from "./kubernetes-controller-rbac";

const NFS_IMAGE =
  "registry.k8s.io/sig-storage/nfs-provisioner@sha256:c825f3d5e28bde099bd7a3daace28772d412c9157ad47fa752a9ad0baafc118d";
const BUN_IMAGE = "oven/bun@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const cluster = await createKubernetesCluster({ networkPolicy: "calico" });
const namespace = "pc-shared";
const server = `${cluster.name}-nfs`;
const image = `${server}:fixture`;
const runtimeTag = `${server}:workspace`;
try {
  await cluster.kube(["create", "namespace", namespace]);
  const config = await controllerKubeconfig(cluster, namespace);
  await cluster.run(["docker", "pull", "registry.k8s.io/kubectl:v1.34.1"]);
  const kubectl = JSON.parse(await cluster.run(["docker", "image", "inspect", "registry.k8s.io/kubectl:v1.34.1"]))[0]
    .RepoDigests[0];
  await cluster.run([
    "bun",
    "build",
    "examples/e2e/kubernetes-shared-probe.ts",
    "--target",
    "bun",
    "--outdir",
    join(cluster.directory, "probe"),
  ]);
  await writeFile(
    join(cluster.directory, "Dockerfile"),
    `FROM ${BUN_IMAGE} AS bun\nFROM ${kubectl} AS kubectl\nFROM ${NFS_IMAGE}\nCOPY --from=bun /usr/local/bin/bun /usr/local/bin/bun\nCOPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl\nCOPY probe /probe\nCOPY ganesha.conf /ganesha.conf\nENTRYPOINT []\nCMD ["sh","-c","mkdir -p /data/shared /data/private /run/ganesha /run/dbus /usr/local/var/run/ganesha; dbus-daemon --system --fork; rpcbind -w; exec ganesha.nfsd -F -p /run/ganesha.pid -L /dev/stderr -f /ganesha.conf"]\n`,
  );
  await writeFile(
    join(cluster.directory, "ganesha.conf"),
    `NFS_CORE_PARAM { Protocols = 4; }\nNFSv4 { Grace_Period = 0; }\nEXPORT { Export_Id = 1; Path = /data/shared; Pseudo = /; Access_Type = RW; Squash = No_Root_Squash; SecType = sys; FSAL { Name = VFS; } }\n`,
  );
  await cluster.run(["docker", "build", "-t", image, cluster.directory]);
  await cluster.run([
    "docker",
    "run",
    "-d",
    "--name",
    server,
    "--network",
    "kind",
    "--cap-add",
    "DAC_READ_SEARCH",
    "--tmpfs",
    "/data:rw,size=67108864",
    image,
  ]);
  const address = await cluster.run([
    "docker",
    "inspect",
    "--format",
    '{{(index .NetworkSettings.Networks "kind").IPAddress}}',
    server,
  ]);
  const items = [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "storage-isolation", namespace },
      spec: {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: [`${address}/32`] } }] }],
      },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: { name: "probe-exec", namespace },
      rules: [{ apiGroups: [""], resources: ["pods/exec"], verbs: ["create", "get"] }],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "probe-exec", namespace },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "probe-exec" },
      subjects: [{ kind: "ServiceAccount", name: "pocketcoder-controller", namespace }],
    },
    {
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: { name: "pc-qualified-nfs" },
      provisioner: "kubernetes.io/no-provisioner",
      volumeBindingMode: "Immediate",
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: `${cluster.name}-shared` },
      spec: {
        capacity: { storage: "64Mi" },
        accessModes: ["ReadWriteMany"],
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "pc-qualified-nfs",
        mountOptions: ["nfsvers=4.1", "actimeo=0"],
        nfs: { server: address, path: "/" },
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "shared", namespace },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: "pc-qualified-nfs",
        volumeName: `${cluster.name}-shared`,
        resources: { requests: { storage: "64Mi" } },
      },
    },
  ];
  await cluster.kube(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  await copyFile(config.internal, join(cluster.directory, "publisher-kubeconfig"));
  await cluster.run(["docker", "cp", join(cluster.directory, "publisher-kubeconfig"), `${server}:/kubeconfig`]);
  await writeFile(join(cluster.directory, "Runtime.Dockerfile"), `FROM ${BUN_IMAGE}\n`);
  await cluster.run([
    "docker",
    "buildx",
    "build",
    "--provenance=false",
    "--load",
    "-f",
    join(cluster.directory, "Runtime.Dockerfile"),
    "-t",
    runtimeTag,
    cluster.directory,
  ]);
  const runtime = await cluster.loadImage(runtimeTag);
  const network = JSON.parse(await cluster.kube(["-n", "kube-system", "get", "daemonset", "calico-node", "-o", "json"]))
    .spec.template.spec;
  console.log(
    JSON.stringify({
      nfs: NFS_IMAGE,
      bun: BUN_IMAGE,
      kubectl,
      runtime,
      nodes: cluster.nodes,
      networkImages: [...network.initContainers, ...network.containers].map(
        (container: { image: string }) => container.image,
      ),
      publisherBundleSha256: new Bun.CryptoHasher("sha256")
        .update(
          Buffer.from(await Bun.file(join(cluster.directory, "probe", "kubernetes-shared-probe.js")).arrayBuffer()),
        )
        .digest("hex"),
      capacityBytes: 64 * 1024 ** 2,
      storageClass: "pc-qualified-nfs",
      driver: "in-tree NFSv4.1; static PVC",
      source: await cluster.run(["git", "rev-parse", "HEAD"]),
    }),
  );
  console.log(
    await cluster.run([
      "docker",
      "exec",
      "-e",
      "KUBECONFIG=/kubeconfig",
      "-e",
      `SHARED_VOLUME=${cluster.name}-shared`,
      "-e",
      `STORAGE_ADDRESS=${address}`,
      "-e",
      `WORKSPACE_IMAGE=${runtime.image}`,
      "-e",
      `FIXTURE_NODES=${cluster.nodes.join(",")}`,
      server,
      "bun",
      "/probe/kubernetes-shared-probe.js",
    ]),
  );
} catch (error) {
  console.error(await cluster.run(["docker", "logs", server]).catch(() => ""));
  console.error(await cluster.kube(["-n", namespace, "get", "events", "--sort-by=.lastTimestamp"]).catch(() => ""));
  throw error;
} finally {
  await cluster.run(["docker", "rm", "-f", server]).catch(() => {});
  await cluster.run(["docker", "image", "rm", image]).catch(() => {});
  await cluster.run(["docker", "image", "rm", runtimeTag]).catch(() => {});
  await cluster.close();
}
