import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TemplateManifest } from "@pstdio/pocketcoder-contracts";
import { accountService, createManagerApp } from "@pstdio/pocketcoder-manager";
import { KubernetesAccounts } from "@pstdio/pocketcoder-manager/kubernetes";
import { ManagerStore } from "@pstdio/pocketcoder-manager/store";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { createKubernetesCluster, ROOT } from "./kubernetes-cluster";
import { installEdge, LOCAL_ZONES } from "./kubernetes-edge";
import { freePort, waitFor } from "./local-process";
import { managerKubeconfig } from "./managed-account-kubeconfig";
import { assertOwnedHosts, checkHostedViews } from "./managed-public-views-checks";
import { removeAccount } from "./managed-public-views-removal";

// Same page fixture as the browser display demo: typed input proves control reaches the workspace.
const page = `<!doctype html><style>body{background:#24496a;color:white;font:32px sans-serif}input{position:absolute;left:100px;top:100px;width:400px;height:50px;font:32px sans-serif}</style><h1>Hosted control</h1><input id="text" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">`;
const fixture = `await import('/opt/pocketcoder/echo-harness.ts');Bun.serve({hostname:'127.0.0.1',port:3000,fetch(request){const url=new URL(request.url);if(url.pathname==='/typed')Bun.write('/tmp/browser-proof',url.searchParams.get('value')??'');return new Response(${JSON.stringify(page)},{headers:{'content-type':'text/html'}})}});`;

type Created = {
  account: { id: string; namespace: string; api_origin: string; view_origin: string };
  operation: { id: string };
};
const cluster = await createKubernetesCluster({ networkPolicy: "calico" });
const originalConfig = process.env.KUBECONFIG;
let store: Awaited<ReturnType<typeof ManagerStore.create>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let edge: Awaited<ReturnType<typeof installEdge>> | undefined;
try {
  edge = await installEdge(cluster);
  const ca = edge.ca;
  process.env.KUBECONFIG = await managerKubeconfig(cluster);
  const controller = await cluster.buildImage("server");
  const browser = await cluster.buildImage("browser");
  const directory = join(cluster.directory, "manager_data");
  const parentPort = freePort();
  const parentOrigin = `https://app.localtest.me:${parentPort}`;
  const config = {
    controllerImage: controller.image,
    runtimeClassName: "pc-runc",
    publicHosts: {
      apiOrigin: `https://${LOCAL_ZONES.api}:${edge.port}`,
      viewOrigin: `https://${LOCAL_ZONES.views}:${edge.port}`,
      issuer: "pocketcoder-local",
      ingressClassName: "pocketcoder",
      ingressNamespace: "pocketcoder-edge",
      trustedIngress: ["10.244.0.0/16"],
    },
  };
  store = await ManagerStore.create(directory);
  const token = await store.createOperator(new Date(Date.now() + 30 * 60_000));
  const start = () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createManagerApp(store as ManagerStore, config).fetch });
  server = start();
  const manager = (path: string, init: RequestInit = {}) =>
    fetch(new URL(path, (server as NonNullable<typeof server>).url), {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
  const create = async (key: string, body: object) =>
    (await (
      await manager("/v1/accounts", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(body) })
    ).json()) as Created;
  const first = await create("embedded-account", { name: "embedded", parents: [parentOrigin] });
  const firstAccount = await store.getAccount(first.account.id);
  if (!firstAccount) throw new Error("Account intent missing");
  // Interrupt after every owned host resource exists but before the manager records success.
  await store.startOperation(first.operation.id);
  await new KubernetesAccounts().ensure(firstAccount).catch((error) => {
    // The certificate is checked last, so every owned resource already exists.
    if (!String(error).includes("certificate is not ready")) throw error;
  });
  await server.stop(true);
  await store.close();
  store = await ManagerStore.create(directory);
  server = start();
  const retry = await create("embedded-account", { name: "embedded", parents: [parentOrigin] });
  if (retry.account.id !== first.account.id || retry.operation.id !== first.operation.id)
    throw new Error("Interrupted create duplicated the account");
  const second = await create("other-account", { name: "other" });
  // Like the manager's timer, keep reconciling until certificates are issued.
  const service = accountService(store);
  await waitFor(
    async () => {
      await service.reconcile();
      const states = [];
      for (const row of [first, second])
        states.push(((await (await manager(`/v1/operations/${row.operation.id}`)).json()) as { state: string }).state);
      return states.every((state) => state === "succeeded");
    },
    180_000,
    "account provisioning",
  );
  const dns = await assertOwnedHosts(cluster, edge, [first.account, second.account]);
  const tlsFetch = ((input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, tls: { ca } })) as typeof fetch;
  const owners = [];
  for (const row of [first, second]) {
    const claimed = await manager(`/v1/accounts/${row.account.id}/owner`, {
      method: "POST",
      body: JSON.stringify({ request_id: randomUUID(), expires_at: new Date(Date.now() + 20 * 60_000).toISOString() }),
    });
    const owner = (await claimed.json()) as { token: string; key: { id: string; principal_id: string } };
    if (!owner.token) throw new Error("Owner plaintext missing");
    const client = new PocketCoderClient({ baseUrl: row.account.api_origin, apiKey: owner.token, fetch: tlsFetch });
    // Verified TLS proves the issued certificate covers the account API host.
    if (!(await tlsFetch(`${row.account.api_origin}/readyz`)).ok) throw new Error("Account API host is not ready");
    owners.push({ ...row.account, token: owner.token, principalId: owner.key.principal_id, client });
  }
  const [one, two] = owners as [(typeof owners)[number], (typeof owners)[number]];
  const template = (await Bun.file(join(ROOT, "examples/templates/browser.json")).json()) as TemplateManifest;
  template.spec.image = browser.image;
  template.spec.harness = { command: ["bun", "/opt/pocketcoder/browser-harness.ts", "bun", "-e", fixture], env: {} };
  template.spec.resources.ephemeralStorage = "1Gi";
  template.spec.previews = { web: { port: 3000 } };
  await one.client.templates.publish(template);
  const workspace = await one.client.workspaces.create({ externalId: randomUUID(), templateName: "browser" });
  await one.client.workspaces.waitForReady(workspace, 180_000);
  const views = await checkHostedViews({ cluster, ca, one, two, workspaceId: workspace.id, parentOrigin, parentPort });
  const removal = await removeAccount(cluster, edge, { ca, one, two, workspaceId: workspace.id });
  console.log(
    JSON.stringify(
      {
        result: "passed",
        accounts: owners.map((o) => ({ id: o.id, api: o.api_origin, views: o.view_origin })),
        retry: "one account, operation, certificate revision and DNS record set after interruption",
        dns,
        ...views,
        removal,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(await cluster.kube(["get", "pods", "-A", "-o", "wide"]).catch(() => ""));
  console.log(await cluster.kube(["get", "certificates,ingresses", "-A"]).catch(() => ""));
  for (const namespace of store ? (await store.listAccounts()).map((a) => a.namespace) : [])
    console.log(
      await cluster.kube(["-n", namespace, "logs", "deployment/controller", "-c", "controller"]).catch(() => ""),
    );
  throw error;
} finally {
  await server?.stop(true);
  await store?.close();
  await edge?.close();
  if (originalConfig === undefined) delete process.env.KUBECONFIG;
  else process.env.KUBECONFIG = originalConfig;
  if (!process.argv.includes("--keep")) await cluster.close();
}
