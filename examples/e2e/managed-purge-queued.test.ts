import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { objectStorageFixture } from "@pstdio/pocketcoder-db/testing";
import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { createKubernetesCluster } from "./kubernetes-cluster";

test.skipIf(process.env.PC94_QUEUED_TEST !== "1")(
  "never-provider-started account purge survives an actual older manager database",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc94-queued-purge-"));
    let cluster: Awaited<ReturnType<typeof createKubernetesCluster>> | undefined;
    let storage: Awaited<ReturnType<typeof objectStorageFixture>> | undefined;
    let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
    let service: ReturnType<typeof accountService> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let failure: unknown;
    const failures: unknown[] = [];
    async function closeManager() {
      await server?.stop(true);
      server = undefined;
      await service?.close();
      service = undefined;
      await store?.close();
      store = undefined;
    }
    try {
      cluster = await createKubernetesCluster();
      storage = await objectStorageFixture();
      const directory = join(root, "manager_data");
      const authority = { directory: join(root, "purge-authority"), storage: storage.config };
      // This is a real immutable local image identity. No provision reconciliation or image admission runs.
      const imageId = (
        await cluster.run(["docker", "image", "inspect", "pocketcoder-workspace:pc105-arm64", "--format", "{{.Id}}"])
      ).trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Owned queued fixture image identity is missing");
      const config = { controllerImage: `pocketcoder-workspace@${imageId}`, runtimeClassName: "pc-runc" };
      let token: string;
      async function open() {
        store = await ManagerStore.create(directory, authority);
        service = accountService(store, new KubernetesAccounts(cluster?.kube));
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config, service).fetch });
      }
      async function request(path: string, input: RequestInit = {}) {
        if (!server) throw new Error("Owned manager is closed");
        return fetch(new URL(path, server.url), {
          ...input,
          signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...input.headers },
        });
      }
      await open();
      if (!store) throw new Error("Owned manager store is missing");
      token = await store.createOperator(new Date(Date.now() + 10 * 60_000));
      const createRequestId = randomUUID();
      const created = await request("/v1/accounts", {
        method: "POST",
        headers: { "idempotency-key": createRequestId },
        body: JSON.stringify({ name: "never-admitted-purge" }),
      });
      expect(created.status).toBe(202);
      const admitted = (await created.json()) as {
        account: { id: string; namespace: string; state: string };
        operation: { id: string; state: string };
      };
      expect(admitted.account.state).toBe("provisioning");
      expect(admitted.operation.state).toBe("pending");
      expect((await store.pendingOperations()).map((operation) => operation.id)).toEqual([admitted.operation.id]);
      await closeManager();
      const stale = join(root, "stale-manager-data");
      await cp(directory, stale, { recursive: true });
      await open();
      const purgeRequestId = randomUUID();
      const purged = await request(`/v1/accounts/${admitted.account.id}/purge`, {
        method: "POST",
        headers: { "idempotency-key": purgeRequestId },
      });
      expect(purged.status).toBe(202);
      const purge = ((await purged.json()) as { operation: { id: string } }).operation;
      await service?.reconcile();
      const status = await request(`/v1/operations/${purge.id}`);
      const state = (await status.json()) as { state: string };
      const placement = await cluster.kube([
        "get",
        "namespace",
        admitted.account.namespace,
        "--ignore-not-found",
        "-o",
        "json",
      ]);
      console.log(
        JSON.stringify({
          queuedPurge: { accountId: admitted.account.id, operationId: purge.id, state, namespaceAbsent: !placement },
        }),
      );
      // Absence is diagnostic. Completion must use external positive admission/start evidence.
      expect(state.state).toBe("succeeded");
      expect(placement).toBe("");
      await closeManager();
      await rm(directory, { recursive: true });
      await cp(stale, directory, { recursive: true });
      await open();
      expect(((await (await request(`/v1/operations/${purge.id}`)).json()) as { state: string }).state).toBe(
        "succeeded",
      );
      const replay = await request("/v1/accounts", {
        method: "POST",
        headers: { "idempotency-key": createRequestId },
        body: JSON.stringify({ name: "never-admitted-purge" }),
      });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({ code: "account_purged" });
      expect(((await (await request("/v1/accounts")).json()) as { items: unknown[] }).items).toEqual([]);
    } catch (error) {
      failure = error;
    } finally {
      for (const cleanup of [
        closeManager,
        () => cluster?.close(),
        () => storage?.close(),
        () => rm(root, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    if (failures.length)
      throw new AggregateError([...(failure ? [failure] : []), ...failures], "Queued purge cleanup failed");
    if (failure) throw failure;
  },
  250_000,
);
