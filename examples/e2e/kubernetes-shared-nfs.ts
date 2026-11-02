import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { createKubernetesCluster } from "./kubernetes-cluster";

const NFS_IMAGE =
  "registry.k8s.io/sig-storage/nfs-provisioner@sha256:c825f3d5e28bde099bd7a3daace28772d412c9157ad47fa752a9ad0baafc118d";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;

// An NFSv4 shared writer whose export lives in a Docker volume, so a controller
// container on the kind network can own the same tree as the qualified claim.
export async function startSharedNfs(cluster: Cluster, namespace: string) {
  const server = `${cluster.name}-nfs`;
  const image = `${server}:fixture`;
  const volume = `${cluster.name}-shared`;
  await writeFile(
    join(cluster.directory, "Nfs.Dockerfile"),
    `FROM ${NFS_IMAGE}\nCOPY ganesha.conf /ganesha.conf\nENTRYPOINT []\nCMD ["sh","-c","mkdir -p /data/shared /run/ganesha /run/dbus /usr/local/var/run/ganesha; dbus-daemon --system --fork; rpcbind -w; exec ganesha.nfsd -F -p /run/ganesha.pid -L /dev/stderr -f /ganesha.conf"]\n`,
  );
  await writeFile(
    join(cluster.directory, "ganesha.conf"),
    `NFS_CORE_PARAM { Protocols = 4; }\nNFSv4 { Grace_Period = 0; }\nEXPORT { Export_Id = 1; Path = /data/shared; Pseudo = /; Access_Type = RW; Squash = No_Root_Squash; SecType = sys; FSAL { Name = VFS; } }\n`,
  );
  await cluster.run([
    "docker",
    "build",
    "-q",
    "-f",
    join(cluster.directory, "Nfs.Dockerfile"),
    "-t",
    image,
    cluster.directory,
  ]);
  await cluster.run(["docker", "volume", "create", volume]);
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
    "-v",
    `${volume}:/data/shared`,
    image,
  ]);
  const address = await cluster.run([
    "docker",
    "inspect",
    "--format",
    '{{(index .NetworkSettings.Networks "kind").IPAddress}}',
    server,
  ]);
  const options = {
    claimName: "shared",
    volumeName: `${cluster.name}-shared`,
    storageClassName: "pc-qualified-nfs",
    profile: "shared-writer-readonly/v1" as const,
    networkPolicyName: "storage-isolation",
    storageCidrs: [`${address}/32`],
  };
  await cluster.kube(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "NetworkPolicy",
          metadata: { name: options.networkPolicyName, namespace },
          spec: {
            podSelector: {},
            policyTypes: ["Egress"],
            egress: [{ to: [{ ipBlock: { cidr: "0.0.0.0/0", except: options.storageCidrs } }] }],
          },
        },
        {
          apiVersion: "storage.k8s.io/v1",
          kind: "StorageClass",
          metadata: { name: options.storageClassName },
          provisioner: "kubernetes.io/no-provisioner",
          volumeBindingMode: "Immediate",
        },
        {
          apiVersion: "v1",
          kind: "PersistentVolume",
          metadata: { name: options.volumeName },
          spec: {
            capacity: { storage: "64Mi" },
            accessModes: ["ReadWriteMany"],
            persistentVolumeReclaimPolicy: "Retain",
            storageClassName: options.storageClassName,
            mountOptions: ["nfsvers=4.1", "actimeo=0"],
            nfs: { server: address, path: "/" },
          },
        },
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: { name: options.claimName, namespace },
          spec: {
            accessModes: ["ReadWriteMany"],
            storageClassName: options.storageClassName,
            volumeName: options.volumeName,
            resources: { requests: { storage: "64Mi" } },
          },
        },
      ],
    }),
  );
  return {
    volume,
    options,
    async close() {
      await cluster.run(["docker", "rm", "-f", server]).catch(() => {});
      await cluster.run(["docker", "volume", "rm", "-f", volume]).catch(() => {});
      await cluster.run(["docker", "image", "rm", image]).catch(() => {});
    },
  };
}
