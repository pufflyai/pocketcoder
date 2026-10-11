import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { connectBrowser } from "./browser-client";
import { checkEmbedBrowsers } from "./embed-browsers";
import { startEmbedGateway } from "./embed-gateway";
import type { createKubernetesCluster } from "./kubernetes-cluster";
import type { installEdge } from "./kubernetes-edge";
import { command, waitFor } from "./local-process";
import { checkBrowserViews } from "./managed-public-views-browser";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;
type Edge = Awaited<ReturnType<typeof installEdge>>;
type Account = { id: string; namespace: string; api_origin: string; view_origin: string };
export type Owner = Account & { token: string; principalId: string; client: PocketCoderClient };
type Records = Awaited<ReturnType<Edge["records"]>>;

const label = (account: { id: string }) => account.id.replaceAll("-", "");
export async function closedWithin(closed: Promise<void>, reason: string, ms = 5000) {
  await Promise.race([closed, Bun.sleep(ms).then(() => Promise.reject(new Error(reason)))]);
}
export const accountRecords = (records: Records, account: { id: string }) =>
  records.filter((set) => set.name.includes(label(account)));

// Each account has one route, one certificate revision and one DNS answer per host.
export async function assertOwnedHosts(cluster: Cluster, edge: Edge, accounts: Account[]) {
  for (const account of accounts) {
    const owned = JSON.parse(
      await cluster.kube([
        "-n",
        account.namespace,
        "get",
        "certificates,certificaterequests,ingresses,secrets",
        "-l",
        `pocketcoder.dev/account=${account.id}`,
        "-o",
        "json",
      ]),
    ).items as { kind: string; type?: string; status?: { revision?: number } }[];
    const count = (kind: string) => owned.filter((item) => item.kind === kind).length;
    if (count("Certificate") !== 1 || count("Ingress") !== 1)
      throw new Error("Account route or certificate duplicated");
    if (owned.filter((item) => item.type === "kubernetes.io/tls").length !== 1)
      throw new Error("Account TLS secret duplicated");
    if (owned.find((item) => item.kind === "Certificate")?.status?.revision !== 1)
      throw new Error("Retry reissued the account certificate");
    const requests = JSON.parse(
      await cluster.kube(["-n", account.namespace, "get", "certificaterequests", "-o", "json"]),
    ).items;
    if (requests.length !== 1) throw new Error("Retry created another certificate request");
  }
  let records: Records = [];
  await waitFor(
    async () => {
      records = await edge.records();
      return accounts.every((account) => {
        const sets = accountRecords(records, account).filter((set) => set.type === "A");
        return (
          sets.length === 2 &&
          sets.every((set) => set.records.length === 1 && set.records[0]?.content === "127.0.0.1") &&
          sets.some((set) => set.name === `${new URL(account.api_origin).hostname}.`) &&
          sets.some((set) => set.name === `*.${new URL(account.view_origin).hostname}.`)
        );
      });
    },
    90_000,
    "account DNS records",
  );
  if (records.some((set) => set.records.length !== 1)) throw new Error("DNS record duplicated");
  if (accounts.some((account) => !accountRecords(records, account).some((set) => set.type === "TXT")))
    throw new Error("DNS ownership records missing");
  return { records: records.length, names: records.map((set) => `${set.type} ${set.name}`).sort() };
}

export function views(ca: string, workspaceId: string) {
  const sockets: WebSocket[] = [];
  async function exchange(minted: { url: string }) {
    const exchanged = await fetch(minted.url, { redirect: "manual", tls: { ca } });
    const cookie = exchanged.headers.get("set-cookie") ?? "";
    if (exchanged.status !== 303 || !cookie.startsWith("__Host-pc-view=") || !cookie.includes("; Secure"))
      throw new Error("Hosted view exchange did not set a Secure host cookie");
    if (/domain=/i.test(cookie) || exchanged.headers.get("location")?.includes("token"))
      throw new Error("Hosted view leaked its cookie scope or token");
    return { url: new URL(minted.url), cookie: cookie.split(";")[0] ?? "" };
  }
  return {
    sockets,
    exchange,
    async open(client: PocketCoderClient, control: boolean) {
      return exchange(await client.displays.open(workspaceId, control, { session: { mode: "top_level" } }));
    },
    async connect(session: { url: URL; cookie: string }) {
      const browser = await connectBrowser(session.url.origin, session.url, session.cookie, ca);
      sockets.push(browser.socket);
      return browser;
    },
  };
}

async function denied(url: string, headers: Record<string, string>, ca: string) {
  const socket = new WebSocket(url, { headers, tls: { ca } } as unknown as string[]);
  const opened = await new Promise<boolean>((resolve) => {
    socket.onopen = () => resolve(true);
    socket.onerror = () => resolve(false);
  });
  socket.close();
  return !opened;
}

export async function checkHostedViews(options: {
  cluster: Cluster;
  ca: string;
  one: Owner;
  two: Owner;
  workspaceId: string;
  parentOrigin: string;
  parentPort: number;
}) {
  const { cluster, ca, one, two, workspaceId } = options;
  const session = views(ca, workspaceId);
  const pods = JSON.parse(
    await cluster.kube([
      "-n",
      one.namespace,
      "get",
      "pods",
      "-l",
      `pocketcoder.workspace=${workspaceId}`,
      "-o",
      "json",
    ]),
  );
  const pod = pods.items[0]?.metadata.name as string;
  const preview = await session.exchange(
    await one.client.previews.open(workspaceId, "web", { session: { mode: "top_level" } }),
  );
  const webapp = await fetch(`${preview.url.origin}/`, { headers: { cookie: preview.cookie }, tls: { ca } });
  if (!preview.url.host.includes(`-web.${label(one)}.embed.`) || !(await webapp.text()).includes("Hosted control"))
    throw new Error("Hosted webapp preview did not load");
  const control = await session.connect(await session.open(one.client, true));
  const controlOpened = Date.now();
  if (!control.socket.url.includes(`.${label(one)}.embed.`)) throw new Error("View is not on the account view zone");
  control.send({ action: "navigate", url: "http://127.0.0.1:3000" });
  await control.capture();
  control.send({ action: "click", x: 150, y: 125 });
  control.send({ action: "text", text: "hosted-control-proof" });
  await waitFor(
    () =>
      cluster.kube(["-n", one.namespace, "exec", pod, "--", "cat", "/tmp/browser-proof"]).then(
        (value) => value === "hosted-control-proof",
        () => false,
      ),
    10_000,
    "hosted browser input",
  );
  const viewer = await session.connect(await session.open(one.client, false));
  await viewer.capture();
  viewer.socket.send(new TextEncoder().encode(JSON.stringify({ action: "click", x: 1, y: 1 })));
  await closedWithin(viewer.closed, "Hosted view-only input stayed open");

  const issued = await one.client.keys.issue(one.principalId, {
    request_id: randomUUID(),
    scopes: ["display:view", "workspaces:read"],
    templates: ["browser"],
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  });
  if (!issued.token) throw new Error("Finite display key missing");
  const finite = new PocketCoderClient({
    baseUrl: one.api_origin,
    apiKey: issued.token,
    fetch: ((input, init) => fetch(input, { ...init, tls: { ca } })) as typeof fetch,
  });
  const revoked = await session.connect(await session.open(finite, false));
  await revoked.capture();
  await one.client.keys.revoke(one.principalId, issued.key.id);
  await closedWithin(revoked.closed, "Revoked hosted view stayed open");
  if (
    await finite.displays.open(workspaceId).then(
      () => true,
      () => false,
    )
  )
    throw new Error("Revoked key reopened a hosted view");

  const open = await session.open(one.client, false);
  const viewHost = open.url.host;
  const crossZone = viewHost.replace(`.${label(one)}.`, `.${label(two)}.`);
  const isolation = {
    wrongOrigin: await denied(`wss://${viewHost}/socket`, { origin: one.api_origin, cookie: open.cookie }, ca),
    otherAccountZone: !(await fetch(`https://${crossZone}/`, { headers: { cookie: open.cookie }, tls: { ca } })).ok,
    apiOnViewHost: !(
      await fetch(`https://${viewHost}/v1/workspaces`, {
        headers: { authorization: `Bearer ${one.token}`, cookie: open.cookie },
        tls: { ca },
      })
    ).ok,
    otherAccountKey:
      (
        await fetch(`${two.api_origin}/v1/workspaces/${workspaceId}`, {
          headers: { authorization: `Bearer ${one.token}` },
          tls: { ca },
        })
      ).status === 401,
    unownedHost: await fetch(`https://${viewHost.replace(`.${label(one)}.`, ".")}/`, { tls: { ca } }).then(
      (response) => !response.ok,
      () => true,
    ),
    controllerOnlyFromEdge: await controllerReachability(cluster, one.namespace),
  };
  if (Object.values(isolation).some((passed) => !passed))
    throw new Error(`Isolation failed: ${JSON.stringify(isolation)}`);

  // Traefik's 60-second request read timeout must not cut long-lived view streams.
  await Bun.sleep(Math.max(0, 65_000 - (Date.now() - controlOpened)));
  const lastFrame = control.frames.at(-1)?.hash;
  control.send({ action: "text", text: "-later" });
  await control.capture(lastFrame);
  for (const socket of session.sockets) socket.close();
  await Bun.sleep(500);
  const browser = await checkBrowserViews({ cluster, ca, one, two, workspaceId, pod });
  const directory = await mkdtemp(join(tmpdir(), "pc-hosted-embed-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  await command(
    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1"].concat([
      "-subj",
      "/CN=app.localtest.me",
      "-addext",
      "subjectAltName=DNS:app.localtest.me",
    ]),
    { quiet: true },
  );
  const gateway = startEmbedGateway({
    port: options.parentPort,
    key,
    cert,
    parentOrigin: options.parentOrigin,
    apiOrigin: one.api_origin,
    baseUrl: one.api_origin,
    client: one.client,
    workspaceId,
  });
  try {
    const embedded = await checkEmbedBrowsers(options.parentOrigin, directory);
    return {
      webapp: "preview page loaded",
      scripted: {
        control: "typed input reached the workspace; stream still live after 65 s",
        viewOnly: "forged input closed the stream",
        revocation: "closed",
      },
      isolation,
      browser,
      embedded,
    };
  } finally {
    await gateway.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

async function controllerReachability(cluster: Cluster, namespace: string) {
  const url = `http://controller.${namespace}.svc:8090/readyz`;
  const edge = await cluster.kube([
    "-n",
    "pocketcoder-edge",
    "exec",
    "deploy/traefik",
    "--",
    "wget",
    "-q",
    "-O-",
    "-T",
    "3",
    url,
  ]);
  const other = await cluster
    .kube([
      "-n",
      "pocketcoder-dns",
      "exec",
      "deploy/pdns",
      "--",
      "python3",
      "-c",
      `import urllib.request;urllib.request.urlopen('${url}',timeout=3)`,
    ])
    .then(
      () => "reached",
      () => "denied",
    );
  return edge.length > 0 && other === "denied";
}
