import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { loadManagerPurgeConfig } from "@pstdio/pocketcoder-manager/purge";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { freePort, waitFor } from "./local-process";
import { managerKubeconfig } from "./managed-account-kubeconfig";
import { requireKindStorage } from "./managed-diagnostics";
import { managedPurgeStorage } from "./managed-purge-storage";
import { loadPurgeWorkspace } from "./managed-purge-workspace";
import { offNodeFixture } from "./off-node-fixture";

export async function managedPurgeFixture(options: { physicalStorage?: boolean } = {}) {
  const storage = await offNodeFixture();
  let cluster: Awaited<ReturnType<typeof createKubernetesCluster>> | undefined;
  let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
  let service: ReturnType<typeof accountService> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let forward: ReturnType<typeof Bun.spawn> | undefined;
  const prior = process.env.KUBECONFIG;
  async function stopManager() {
    await server?.stop(true);
    server = undefined;
    await service?.close();
    service = undefined;
    await store?.close();
    store = undefined;
  }
  async function close() {
    const failures: unknown[] = [];
    if (forward) {
      forward.kill();
      await forward.exited;
    }
    for (const result of await Promise.allSettled([stopManager()]))
      if (result.status === "rejected") failures.push(result.reason);
    process.env.KUBECONFIG = prior;
    for (const result of await Promise.allSettled([cluster?.close(), storage.close()]))
      if (result.status === "rejected") failures.push(result.reason);
    if (failures.length) throw new AggregateError(failures, "Managed purge fixture cleanup failed");
  }
  try {
    const owned = await createKubernetesCluster({ networkPolicy: "calico" });
    cluster = owned;
    const kubeconfig = await managerKubeconfig(owned);
    process.env.KUBECONFIG = kubeconfig;
    const controller = await owned.buildImage("server", { hostBundled: true });
    const workspaceImage = options.physicalStorage ? await loadPurgeWorkspace(owned) : undefined;
    const backups = await storage.configure(owned);
    await requireKindStorage(owned);
    const directory = join(owned.directory, "manager_data");
    const purgeConfig = join(owned.directory, "purge-config.json");
    await writeFile(
      purgeConfig,
      JSON.stringify({ directory: join(owned.directory, "purge-authority"), storage: storage.storage.config }),
      { mode: 0o600 },
    );
    const authority = await loadManagerPurgeConfig(purgeConfig, directory);
    const config = { controllerImage: controller.image, runtimeClassName: "pc-runc", offNodeBackups: true };
    const physical = options.physicalStorage ? await managedPurgeStorage(owned) : undefined;
    const physicalFailures: { volumeId: string; busy: boolean }[] = [];
    const observedPhysical = physical
      ? {
          inventory: physical.inventory,
          dnsRecords: physical.dnsRecords,
          dnsAbsent: physical.dnsAbsent,
          async removeAndVerify(input: Parameters<typeof physical.removeAndVerify>[0]) {
            try {
              return await physical.removeAndVerify(input);
            } catch (error) {
              const busy = error instanceof Error && error.message.includes("Device or resource busy");
              physicalFailures.push({ volumeId: input.volumeId, busy });
              console.log(JSON.stringify({ actualPurgeStorageRefusal: { volumeId: input.volumeId, busy } }));
              throw error;
            }
          },
        }
      : undefined;
    console.log(
      JSON.stringify({
        purgeFixtureOwnership: {
          cluster: owned.name,
          privateDirectory: owned.directory,
          managerDirectory: directory,
          authorityDirectory: authority.directory,
          nodes: await Promise.all(
            owned.nodes.map(async (name) => ({
              name,
              id: await owned.run(["docker", "inspect", "--format", "{{.Id}}", name]),
            })),
          ),
          objectStorage: {
            name: storage.storage.config.bucket,
            id: await owned.run(["docker", "inspect", "--format", "{{.Id}}", storage.storage.config.bucket]),
          },
          controllerImage: controller.tag,
        },
      }),
    );
    async function openManager() {
      store = await ManagerStore.create(directory, authority);
      service = accountService(store, new KubernetesAccounts(undefined, backups), observedPhysical);
      server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config, service).fetch });
    }
    await openManager();
    if (!store) throw new Error("Owned manager store is missing.");
    const operatorToken = await store.createOperator(new Date(Date.now() + 30 * 60_000));
    return {
      cluster: owned,
      storage,
      directory,
      kubeconfig,
      operatorToken,
      controllerImage: controller.image,
      workspaceImage,
      physicalFailures: () => physicalFailures,
      backupConfig: join(owned.directory, "off-node-config.json"),
      purgeConfig,
      async request(path: string, input: RequestInit = {}) {
        if (!server) throw new Error("Manager has handed off its owned folder");
        return fetch(new URL(path, server.url), {
          ...input,
          signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json", ...input.headers },
        });
      },
      reconcile: () => service?.reconcile(),
      openManager,
      async connect(namespace: string) {
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
            fetch(`${url}/livez`, { signal: AbortSignal.timeout(1000) })
              .then((r) => r.ok)
              .catch(() => false),
          30_000,
          "owned controller forward",
        );
        return url;
      },
      stopManager,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Managed purge setup and cleanup failed");
    }
    throw error;
  }
}
