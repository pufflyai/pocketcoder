import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { certManagerManifest } from "../../deploy/digitalocean/edge/cert-manager";
import { type createKubernetesCluster, ROOT } from "./kubernetes-cluster";
import { freePort, waitFor } from "./local-process";

type Cluster = Awaited<ReturnType<typeof createKubernetesCluster>>;
type Resource = { kind: string; metadata: { name: string }; spec: { template: { spec: Pod } } };
type Pod = { containers: { args: string[]; env?: unknown[] }[] };

const PDNS =
  "docker.io/powerdns/pdns-auth-50:5.0.7@sha256:4d6cc4fc42a28f2df7fb55f6f36d8323f96e0da66135ccdad057ca7349b223b4";
export const LOCAL_ZONES = { api: "pocketcoder.localtest.me", views: "embed.lvh.me" };

const localIssuer = [
  {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: { name: "local-root" },
    spec: { selfSigned: {} },
  },
  {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: { name: "pocketcoder-local-ca", namespace: "cert-manager" },
    spec: {
      isCA: true,
      commonName: "PocketCoder local edge CA",
      secretName: "pocketcoder-local-ca",
      privateKey: { algorithm: "ECDSA", size: 256 },
      issuerRef: { group: "cert-manager.io", kind: "ClusterIssuer", name: "local-root" },
    },
  },
  {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: { name: "pocketcoder-local" },
    spec: { ca: { secretName: "pocketcoder-local-ca" } },
  },
];

export function forward(cluster: Cluster, namespace: string, target: string, remotePort: number) {
  const port = freePort();
  const child = Bun.spawn(["kubectl", "-n", namespace, "port-forward", target, `${port}:${remotePort}`], {
    env: { ...process.env, ...cluster.env },
    stdout: "ignore",
    stderr: "ignore",
  });
  const ready = waitFor(
    async () => {
      const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } }).catch(() => null);
      socket?.end();
      return Boolean(socket);
    },
    15_000,
    `${target} forwarding`,
  );
  return {
    port,
    ready,
    async stop() {
      child.kill();
      await child.exited;
    },
  };
}

async function ready(cluster: Cluster, kind: string, name: string) {
  const args = ["get", kind, name, "-o", "json"];
  await waitFor(
    async () => {
      const resource = JSON.parse(await cluster.kube(args).catch(() => "{}"));
      return resource.status?.conditions?.some(
        (c: { type: string; status: string }) => c.type === "Ready" && c.status === "True",
      );
    },
    90_000,
    `${kind} ${name} ready`,
  );
}

// Same edge manifests as DigitalOcean; only the cloud DNS provider and CA differ locally.
export async function installEdge(cluster: Cluster) {
  const kube = cluster.kube;
  for (const node of cluster.nodes) await kube(["label", "node", node, "pocketcoder.dev/pool=system", "--overwrite"]);
  await kube(["create", "-f", "-"], await certManagerManifest());
  for (const name of ["cert-manager", "cert-manager-cainjector", "cert-manager-webhook"])
    await kube(["-n", "cert-manager", "rollout", "status", `deployment/${name}`, "--timeout=120s"]);
  const traefik = await Bun.file(join(ROOT, "deploy/digitalocean/edge/traefik.yaml")).text();
  await kube(
    ["apply", "-f", "-"],
    traefik
      .replace("REPLACE_LOAD_BALANCER_NAME", "pocketcoder-local-edge")
      .replace("REPLACE_ALLOWED_SOURCE_CIDR", "127.0.0.1/32"),
  );
  await kube(["-n", "pocketcoder-edge", "rollout", "status", "deployment/traefik", "--timeout=120s"]);
  // kind has no cloud load balancer. Publish the address a cloud controller would report.
  await kube([
    "-n",
    "pocketcoder-edge",
    "patch",
    "service",
    "traefik",
    "--subresource=status",
    "--type=merge",
    "-p",
    JSON.stringify({ status: { loadBalancer: { ingress: [{ ip: "127.0.0.1" }] } } }),
  ]);
  // The webhook can refuse issuers for a few seconds after its rollout finishes.
  await waitFor(
    () =>
      kube(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: localIssuer })).then(
        () => true,
        () => false,
      ),
    60_000,
    "cert-manager webhook",
  );
  await ready(cluster, "clusterissuer", "pocketcoder-local");
  const caSecret = JSON.parse(
    await kube(["-n", "cert-manager", "get", "secret", "pocketcoder-local-ca", "-o", "json"]),
  );
  const ca = Buffer.from(caSecret.data["ca.crt"], "base64").toString();
  const dns = await installLocalDns(cluster);
  const edge = forward(cluster, "pocketcoder-edge", "service/traefik", 443);
  await edge.ready;
  return {
    port: edge.port,
    ca,
    records: dns.records,
    async close() {
      await edge.stop();
      await dns.close();
    },
  };
}

async function installLocalDns(cluster: Cluster) {
  const kube = cluster.kube;
  const key = randomBytes(24).toString("hex");
  const labels = { "app.kubernetes.io/name": "pdns" };
  await kube(["create", "namespace", "pocketcoder-dns"]);
  await kube(["-n", "pocketcoder-dns", "create", "secret", "generic", "pdns", `--from-literal=key=${key}`]);
  const keyRef = { valueFrom: { secretKeyRef: { name: "pdns", key: "key" } } };
  await kube(
    ["apply", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: "pdns", namespace: "pocketcoder-dns" },
          spec: {
            selector: { matchLabels: labels },
            template: {
              metadata: { labels },
              spec: { containers: [{ name: "pdns", image: PDNS, env: [{ name: "PDNS_AUTH_API_KEY", ...keyRef }] }] },
            },
          },
        },
        {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "pdns", namespace: "pocketcoder-dns" },
          spec: { selector: labels, ports: [{ name: "api", port: 8081 }] },
        },
      ],
    }),
  );
  await kube(["-n", "pocketcoder-dns", "rollout", "status", "deployment/pdns", "--timeout=120s"]);
  const api = forward(cluster, "pocketcoder-dns", "service/pdns", 8081);
  await api.ready;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${api.port}/api/v1/servers/localhost${path}`, {
      ...init,
      headers: { "x-api-key": key, "content-type": "application/json" },
    });
  for (const zone of Object.values(LOCAL_ZONES)) {
    const created = await request("/zones", {
      method: "POST",
      body: JSON.stringify({ name: `${zone}.`, kind: "Native", nameservers: ["ns.invalid."] }),
    });
    if (!created.ok) throw new Error(`Local DNS zone refused: ${await created.text()}`);
  }
  const resources = Bun.YAML.parse(
    await Bun.file(join(ROOT, "deploy/digitalocean/edge/external-dns.yaml")).text(),
  ) as Resource[];
  const shipped = { apiVersion: "v1", kind: "List", items: resources.filter((r) => r.kind !== "Namespace") };
  // The shipped arguments must reach DigitalOcean; an invalid token proves it without any cloud write.
  await kube([
    "-n",
    "pocketcoder-dns",
    "create",
    "secret",
    "generic",
    "digitalocean-dns",
    "--from-literal=token=invalid",
  ]);
  await kube(["apply", "-f", "-"], JSON.stringify(shipped));
  await waitFor(
    async () => {
      const logs = await kube(["-n", "pocketcoder-dns", "logs", "deploy/external-dns"]).catch(() => "");
      return logs.includes("GET https://api.digitalocean.com/v2/domains") && logs.includes("401");
    },
    90_000,
    "shipped external-dns DigitalOcean provider",
  );
  const deployment = resources.find((r) => r.kind === "Deployment");
  const container = deployment?.spec.template.spec.containers[0];
  if (!container) throw new Error("external-dns Deployment is missing");
  container.args = container.args
    .filter(
      (arg) => !arg.startsWith("--provider=") && !arg.startsWith("--domain-filter=") && !arg.startsWith("--interval="),
    )
    .concat([
      "--provider=pdns",
      "--pdns-server=http://pdns.pocketcoder-dns.svc:8081",
      ...Object.values(LOCAL_ZONES).map((zone) => `--domain-filter=${zone}`),
      "--interval=5s",
    ]);
  container.env = [{ name: "EXTERNAL_DNS_PDNS_API_KEY", ...keyRef }];
  await kube(["apply", "-f", "-"], JSON.stringify(shipped));
  await kube(["-n", "pocketcoder-dns", "rollout", "status", "deployment/external-dns", "--timeout=120s"]);
  return {
    async records() {
      const sets: { name: string; type: string; records: { content: string }[] }[] = [];
      for (const zone of Object.values(LOCAL_ZONES)) {
        const response = await request(`/zones/${zone}.`);
        if (!response.ok) throw new Error("Local DNS zone read failed");
        sets.push(...((await response.json()) as { rrsets: typeof sets }).rrsets);
      }
      return sets.filter((set) => set.type === "A" || set.type === "TXT");
    },
    close: () => api.stop(),
  };
}
