import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import { ROOT } from "./kubernetes-cluster";

const BUN_IMAGE = "oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";
const KUBECTL_IMAGE = "registry.k8s.io/kubectl:v1.34.1";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;

// Runs this checkout's controller on the kind network. Workspaces reach its
// agent port by container IP, which the storage policy leaves open.
export async function startSharedController(
  cluster: Cluster,
  options: { kubeconfig: string; volume: string; env: Record<string, string> },
) {
  const directory = join(cluster.directory, "controller");
  for (const [entry, out] of [
    ["packages/server/src/index.ts", "server"],
    ["packages/cli/src/index.ts", "cli"],
  ] as const) {
    const build = await Bun.build({ entrypoints: [join(ROOT, entry)], outdir: join(directory, out), target: "bun" });
    if (!build.success) throw new Error(`${entry} build failed`);
  }
  await copyFile(options.kubeconfig, join(directory, "kubeconfig"));
  await writeFile(
    join(directory, "Dockerfile"),
    `FROM ${KUBECTL_IMAGE} AS kubectl\nFROM ${BUN_IMAGE}\nCOPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl\nCOPY server /opt/pocketcoder/server\nCOPY cli /opt/pocketcoder/cli\nCOPY kubeconfig /opt/pocketcoder/kubeconfig\n`,
  );
  const name = `${cluster.name}-controller`;
  const image = `${name}:fixture`;
  await cluster.run(["docker", "build", "-q", "-t", image, directory]);
  const env = {
    KUBECONFIG: "/opt/pocketcoder/kubeconfig",
    POCKETCODER_STORE: "pglite",
    POCKETCODER_DIR: "/data/private/core",
    POCKETCODER_HTTP: "0.0.0.0:7080",
    POCKETCODER_AGENT_HTTP: "0.0.0.0:7081",
    POCKETCODER_DRIVER: "kubernetes",
    ...options.env,
  };
  await cluster.run([
    "docker",
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "kind",
    "-p",
    "127.0.0.1::7080",
    "-v",
    `${options.volume}:/data/shared`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "--entrypoint",
    "sh",
    image,
    "-c",
    // The agent URL needs this container's own address on the kind network.
    `POCKETCODER_WORKSPACE_SERVER_URL="http://$(awk -v h="$(cat /etc/hostname)" '$2==h && $1 ~ /^[0-9.]+$/ {print $1; exit}' /etc/hosts):7081" exec bun /opt/pocketcoder/server/index.js`,
  ]);
  const port = (await cluster.run(["docker", "port", name, "7080/tcp"])).split(":").pop();
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (
    !(await fetch(`${url}/readyz`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline)
      throw new Error(await cluster.run(["sh", "-c", `docker logs ${name} 2>&1 | tail -40`]).catch(() => "no logs"));
    await Bun.sleep(500);
  }
  const owner = await cluster.run([
    "docker",
    "exec",
    name,
    "bun",
    "/opt/pocketcoder/cli/index.js",
    "superuser",
    "create",
    "--dir",
    env.POCKETCODER_DIR,
    "--automation",
    "--expires",
    new Date(Date.now() + 3_600_000).toISOString(),
    "--json",
  ]);
  return {
    name,
    url,
    token: JSON.parse(owner).token as string,
    logs: () => cluster.run(["sh", "-c", `docker logs --tail 80 ${name} 2>&1`]).catch(() => ""),
    async close() {
      await cluster.run(["docker", "rm", "-f", name]).catch(() => {});
      await cluster.run(["docker", "image", "rm", image]).catch(() => {});
    },
  };
}
