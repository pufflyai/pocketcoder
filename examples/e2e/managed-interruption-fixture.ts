import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { freePort, waitFor } from "./local-process";
import { managerKubeconfig } from "./managed-account-kubeconfig";
import { requireKindStorage } from "./managed-diagnostics";
import type { ManagerChildInput } from "./managed-interruption-child";
import { managerChild } from "./managed-interruption-debugger";
import { offNodeFixture } from "./off-node-fixture";

export async function managedInterruptionFixture() {
  const storage = await offNodeFixture();
  let cluster: Awaited<ReturnType<typeof createKubernetesCluster>> | undefined;
  let manager: Awaited<ReturnType<typeof managerChild>> | undefined;
  let forward: ReturnType<typeof Bun.spawn> | undefined;
  async function close() {
    try {
      await manager?.close();
    } finally {
      if (forward) {
        forward.kill();
        await forward.exited;
      }
      try {
        await cluster?.close();
      } finally {
        await storage.close();
      }
    }
  }
  try {
    const owned = await createKubernetesCluster({ networkPolicy: true });
    cluster = owned;
    const kubeconfig = await managerKubeconfig(owned);
    const candidate = process.env.POCKETCODER_E2E_WORKSPACE_IMAGE;
    if (!candidate) throw new Error("Set the protected workspace image for the interruption fixture");
    await owned.run(["kind", "load", "docker-image", "--name", owned.name, candidate]);
    const reference = `docker.io/library/${candidate}`;
    const listing = await owned.run([
      "docker",
      "exec",
      owned.nodes[0] as string,
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
    if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Borrowed workspace digest is missing");
    const image = `${reference.split(":")[0]}@${digest}`;
    for (const node of owned.nodes)
      await owned.run(["docker", "exec", node, "ctr", "--namespace", "k8s.io", "images", "tag", reference, image]);
    const workspace = { image, tag: candidate };
    const controller = await owned.buildImage("server", { hostBundled: true });
    await storage.configure(owned);
    await requireKindStorage(owned);
    const directory = join(owned.directory, "manager_data");
    const store = await ManagerStore.create(directory);
    let token: string;
    try {
      token = await store.createOperator(new Date(Date.now() + 30 * 60_000));
    } finally {
      await store.close();
    }
    const config = join(owned.directory, "manager-child.json");
    const input: ManagerChildInput = {
      directory,
      controllerImage: controller.image,
      backupConfig: join(owned.directory, "off-node-config.json"),
    };
    await writeFile(config, JSON.stringify(input), { mode: 0o600 });
    async function start() {
      if (manager) throw new Error("Manager child already owns the database");
      manager = await managerChild(config, kubeconfig);
    }
    await start();
    return {
      cluster: owned,
      workspace,
      storage,
      async request(path: string, input: RequestInit = {}) {
        if (!manager) throw new Error("Manager child is not running");
        return fetch(new URL(path, manager.url), {
          ...input,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
        });
      },
      reconcile() {
        if (!manager) throw new Error("Manager child is not running");
        return manager.reconcile();
      },
      arm(file: string, after: string, statement: string) {
        if (!manager) throw new Error("Manager child is not running");
        return manager.arm(file, after, statement);
      },
      async kill() {
        if (!manager) throw new Error("Manager child is not running");
        await manager.kill();
        manager = undefined;
      },
      async stop() {
        await manager?.close();
        manager = undefined;
      },
      start,
      async readStore<T>(read: (store: Awaited<ReturnType<typeof ManagerStore.create>>) => Promise<T>) {
        if (manager) throw new Error("Cannot read the database while its child is live");
        const store = await ManagerStore.create(directory);
        try {
          return await read(store);
        } finally {
          await store.close();
        }
      },
      async connect(namespace: string) {
        if (forward) {
          forward.kill();
          await forward.exited;
        }
        const port = freePort();
        forward = Bun.spawn(["kubectl", "-n", namespace, "port-forward", "service/controller", `${port}:8090`], {
          env: { ...process.env, KUBECONFIG: kubeconfig },
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
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
