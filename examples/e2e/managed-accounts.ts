import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { createKubernetesCluster } from "./kubernetes-cluster";
import { freePort, waitFor } from "./local-process";
import { managerKubeconfig } from "./managed-account-kubeconfig";
import { assertManagedIsolation, runManagedEcho } from "./managed-account-probes";

const cluster = await createKubernetesCluster({ networkPolicy: true });
const originalConfig = process.env.KUBECONFIG;
let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const forwards: ReturnType<typeof Bun.spawn>[] = [];
try {
  process.env.KUBECONFIG = await managerKubeconfig(cluster);
  const workspace = await cluster.buildImage("workspace");
  const controller = await cluster.buildImage("server");
  const directory = join(cluster.directory, "manager_data");
  store = await ManagerStore.create(directory);
  const token = await store.createOperator(new Date(Date.now() + 30 * 60_000));
  const config = { controllerImage: controller.image, runtimeClassName: "pc-runc" };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config).fetch });
  let url = server.url.toString();
  const request = (path: string, options: RequestInit = {}) =>
    fetch(new URL(path, url), {
      ...options,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers },
    });
  const create = (name: string, identity: string) =>
    request("/v1/accounts", {
      method: "POST",
      headers: { "idempotency-key": identity },
      body: JSON.stringify({ name }),
    });
  const first = (await (await create("first", "first-account")).json()) as {
    account: { id: string; namespace: string };
    operation: { id: string };
  };
  const account = await store.getAccount(first.account.id);
  if (!account) throw new Error("Account intent missing");
  await store.startOperation(first.operation.id);
  await cluster.kube(
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: account.namespace, labels: { "pocketcoder.dev/account": account.id } },
    }),
  );
  await server.stop(true);
  await store.close();
  store = await ManagerStore.create(directory);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store, config).fetch });
  url = server.url.toString();
  const retry = (await (await create("first", "first-account")).json()) as typeof first;
  if (retry.account.id !== first.account.id || retry.operation.id !== first.operation.id)
    throw new Error("Interrupted create duplicated account");
  if ((await create("changed", "first-account")).status !== 409) throw new Error("Changed idempotent input accepted");
  const second = (await (await create("second", "second-account")).json()) as typeof first;
  await accountService(store).reconcile();
  for (const row of [first, second]) {
    const status = (await (await request(`/v1/operations/${row.operation.id}`)).json()) as {
      state: string;
      errorCode?: string;
    };
    if (status.state !== "succeeded") throw new Error(`Account provisioning did not finish: ${JSON.stringify(status)}`);
  }
  const accounts = (await (await request("/v1/accounts")).json()) as { items: unknown[] };
  if (accounts.items.length !== 2) throw new Error("Manager account inventory differs");
  const owners: { token: string; namespace: string; accountId: string; baseUrl: string }[] = [];
  for (const row of [first, second]) {
    const identity = randomUUID();
    const expires_at = new Date(Date.now() + 10 * 60_000).toISOString();
    const claim = (input: object) =>
      request(`/v1/accounts/${row.account.id}/owner`, { method: "POST", body: JSON.stringify(input) });
    const input = { request_id: identity, expires_at };
    const issued = await claim(input);
    if (!issued.ok) throw new Error(`Owner bootstrap refused: ${await issued.text()}`);
    let owner: { token: string | null; key: { id: string } };
    if (row === second) {
      // Lose the successful response without reading or saving its plaintext.
      await issued.body?.cancel();
      owner = (await (await claim(input)).json()) as typeof owner;
      if (owner.token !== null) throw new Error("Lost owner plaintext replayed");
    } else owner = (await issued.json()) as typeof owner;
    const replay = (await (await claim(input)).json()) as typeof owner;
    if (replay.token !== null || replay.key.id !== owner.key.id) throw new Error("Owner plaintext replayed");
    if ((await claim({ ...input, request_id: randomUUID() })).status !== 409)
      throw new Error("Second bootstrap accepted");
    if (row === second) {
      // Discarded plaintext is recovered only by explicit replacement, never by replay.
      const lostKeyId = owner.key.id;
      owner = (await (
        await claim({ request_id: randomUUID(), expires_at, replaces_request_id: identity })
      ).json()) as typeof owner;
      if (!owner.token || owner.key.id === lostKeyId) throw new Error("Lost response replacement failed");
    }
    if (!owner.token) throw new Error("Owner plaintext missing");
    const port = freePort();
    const forward = Bun.spawn(
      ["kubectl", "-n", row.account.namespace, "port-forward", "service/controller", `${port}:8090`],
      { env: { ...process.env }, stdout: "ignore", stderr: "ignore" },
    );
    forwards.push(forward);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      () =>
        fetch(`${baseUrl}/readyz`)
          .then((r) => r.ok)
          .catch(() => false),
      10_000,
      "account API forwarding",
    );
    owners.push({ token: owner.token, namespace: row.account.namespace, accountId: row.account.id, baseUrl });
  }
  const manifest = await cluster.echoTemplate(workspace.image);
  manifest.spec.resources.ephemeralStorage = "128Mi";
  const running = await runManagedEcho(owners[0] as (typeof owners)[number], manifest);
  await assertManagedIsolation(cluster, owners, running.workspaceId);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        accounts: owners.map((o) => o.accountId),
        retry: "one account and operation after restart",
        ownerBootstrap: "finite, once; lost response replaced",
        isolation: "separate controller/PGlite PVC, quota, RBAC and enforced Calico cross-account denial",
        echo: "working agent",
        runtimeClass: "pc-runc",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(await cluster.kube(["get", "pods", "-A", "-o", "wide"]).catch(() => ""));
  const namespaces = store ? (await store.listAccounts()).map((a) => a.namespace) : [];
  for (const namespace of namespaces)
    console.log(
      await cluster.kube(["-n", namespace, "logs", "deployment/controller", "-c", "controller"]).catch(() => ""),
    );
  throw error;
} finally {
  for (const forward of forwards) {
    forward.kill();
    await forward.exited;
  }
  await server?.stop(true);
  await store?.close();
  if (originalConfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = originalConfig;
  await cluster.close();
}
