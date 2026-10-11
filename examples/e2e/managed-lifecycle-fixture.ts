import { join } from "node:path";
import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import type { ManagerBackupConfig } from "@pstdio/pocketcoder-manager/backup";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { freePort, waitFor } from "./local-process";
import { managerKubeconfig } from "./managed-account-kubeconfig";
import { requireKindStorage } from "./managed-diagnostics";

export async function managedLifecycleFixture(
  configureBackups?: (cluster: Awaited<ReturnType<typeof createKubernetesCluster>>) => Promise<ManagerBackupConfig>,
) {
  const cluster = await createKubernetesCluster({ networkPolicy: true });
  const priorConfig = process.env.KUBECONFIG;
  let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
  let service: ReturnType<typeof accountService> | undefined;
  let manager: ReturnType<typeof Bun.serve> | undefined;
  let forward: ReturnType<typeof Bun.spawn> | undefined;
  async function close() {
    if (forward) {
      forward.kill();
      await forward.exited;
    }
    await manager?.stop(true);
    await service?.close();
    await store?.close();
    process.env.KUBECONFIG = priorConfig;
    await cluster.close();
  }
  try {
    process.env.KUBECONFIG = await managerKubeconfig(cluster);
    const candidate = process.env.POCKETCODER_E2E_WORKSPACE_IMAGE;
    let workspace: { image: string; tag: string };
    if (candidate) {
      await cluster.run(["kind", "load", "docker-image", "--name", cluster.name, candidate]);
      const reference = `docker.io/library/${candidate}`;
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
      if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Candidate image digest is missing");
      const image = `${reference.split(":")[0]}@${digest}`;
      for (const node of cluster.nodes)
        await cluster.run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "tag", reference, image]);
      workspace = { image, tag: candidate };
    } else workspace = await cluster.buildImage("workspace");
    const controller = await cluster.buildImage("server", { hostBundled: configureBackups !== undefined });
    const backups = await configureBackups?.(cluster);
    if (backups) await requireKindStorage(cluster);
    const directory = join(cluster.directory, "manager_data");
    const config = {
      controllerImage: controller.image,
      runtimeClassName: "pc-runc",
      ...(backups ? { offNodeBackups: true } : {}),
    };
    store = await ManagerStore.create(directory);
    const token = await store.createOperator(new Date(Date.now() + 30 * 60_000));
    service = accountService(store, new KubernetesAccounts(undefined, backups));
    manager = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config, service).fetch });
    const request = (path: string, input: RequestInit = {}) =>
      fetch(new URL(path, manager?.url), {
        ...input,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
      });
    async function restartManager() {
      await manager?.stop(true);
      await service?.close();
      await store?.close();
      store = await ManagerStore.create(directory);
      service = accountService(store, new KubernetesAccounts(undefined, backups));
      manager = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config, service).fetch });
    }
    async function connect(namespace: string) {
      if (forward) {
        forward.kill();
        await forward.exited;
      }
      const port = freePort();
      forward = Bun.spawn(["kubectl", "-n", namespace, "port-forward", "service/controller", `${port}:8090`], {
        env: { ...process.env },
        stdout: "ignore",
        stderr: "ignore",
      });
      const url = `http://127.0.0.1:${port}`;
      await waitFor(
        () =>
          fetch(`${url}/livez`)
            .then((response) => response.ok)
            .catch(() => false),
        10_000,
        "account forwarding",
      );
      return url;
    }
    return {
      cluster,
      workspace,
      request,
      restartManager,
      connect,
      reconcile: () => service?.reconcile(),
      currentStore: () => store,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
