import type { createKubernetesCluster } from "./kubernetes-cluster";

export async function loadPurgeWorkspace(cluster: Awaited<ReturnType<typeof createKubernetesCluster>>) {
  const tag = process.env.POCKETCODER_E2E_WORKSPACE_IMAGE;
  if (!tag) throw new Error("Provide an immutable prepared local workspace fixture image.");
  await cluster.run(["kind", "load", "docker-image", "--name", cluster.name, tag]);
  const reference = `docker.io/library/${tag}`;
  const listing = await cluster.run([
    "docker",
    "exec",
    cluster.nodes[0] as string,
    "ctr",
    "--namespace",
    "k8s.io",
    "images",
    "ls",
  ]);
  const digest = listing
    .split("\n")
    .find((line) => line.startsWith(`${reference} `))
    ?.split(/\s+/)[2];
  if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Loaded workspace image identity is missing.");
  const image = `${reference.split(":")[0]}@${digest}`;
  for (const node of cluster.nodes)
    await cluster.run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "tag", reference, image]);
  return image;
}
