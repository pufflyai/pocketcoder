import { expect, test } from "bun:test";
import { publicViewConfig } from "@pstdio/pocketcoder-server/public-views";
import { accountPlan, ManagerConfigSchema } from "../config";
import type { Account } from "../database/store";
import { accountManifests } from "./manifests";

const id = "0f6c3b5e-9d0a-4c61-8f3e-6b2a1c9d7e40";
const label = id.replaceAll("-", "");
const config = ManagerConfigSchema.parse({
  controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`,
  runtimeClassName: "pc-runc",
  publicHosts: {
    apiOrigin: "https://pocketcoder.datazine.app",
    viewOrigin: "https://embed.kaset.dev",
    issuer: "pocketcoder-dns",
    ingressClassName: "pocketcoder",
    ingressNamespace: "pocketcoder-edge",
    trustedIngress: ["10.244.0.0/16"],
  },
});
const account = (plan: Account["plan"]): Account => ({
  id,
  name: "one",
  namespace: `pc-account-${label}`,
  requestId: "one",
  requestDigest: "digest",
  plan,
  state: "provisioning",
  bootstrapRequestId: null,
  createdAt: new Date(),
});
type Resource = { kind: string; metadata: { name: string; namespace?: string; labels?: object }; spec?: unknown };
const render = (plan: Account["plan"]) => accountManifests(account(plan), ["10.0.0.1"]) as Resource[];

test("an account owns its API host, wildcard view zone, certificate and route", () => {
  const resources = render(accountPlan(config, { name: "one", parents: ["https://app.example.org"] }));
  const names = [`${label}.pocketcoder.datazine.app`, `*.${label}.embed.kaset.dev`];
  const owned = { namespace: `pc-account-${label}`, labels: { "pocketcoder.dev/account": id } };
  expect(resources.find((r) => r.kind === "Certificate")).toEqual({
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: { name: "public-hosts", ...owned },
    spec: {
      secretName: "public-hosts-tls",
      secretTemplate: { labels: owned.labels },
      dnsNames: names,
      issuerRef: { group: "cert-manager.io", kind: "ClusterIssuer", name: "pocketcoder-dns" },
      privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
    },
  } as Resource);
  const backend = { service: { name: "controller", port: { name: "http" } } };
  expect(resources.find((r) => r.kind === "Ingress")?.spec).toEqual({
    ingressClassName: "pocketcoder",
    tls: [{ hosts: names, secretName: "public-hosts-tls" }],
    rules: names.map((host) => ({ host, http: { paths: [{ path: "/", pathType: "Prefix", backend }] } })),
  });
  const controller = resources.find((r) => r.kind === "NetworkPolicy" && r.metadata.name === "controller")?.spec as {
    ingress: unknown[];
  };
  expect(controller.ingress).toContainEqual({
    from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "pocketcoder-edge" } } }],
    ports: [{ protocol: "TCP", port: 8090 }],
  });
  const deployment = resources.find((r) => r.kind === "Deployment") as unknown as {
    spec: { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
  };
  const env = deployment.spec.template.spec.containers[0]?.env.find((e) => e.name === "POCKETCODER_PUBLIC_VIEWS");
  expect(publicViewConfig(env?.value)).toEqual({
    apiOrigin: `https://${label}.pocketcoder.datazine.app`,
    origin: `https://${label}.embed.kaset.dev`,
    parents: ["https://app.example.org"],
    trustedIngress: ["10.244.0.0/16"],
  });
});

test("accounts without public hosts render no route, certificate or public view origin", () => {
  const { publicHosts: _, ...local } = config;
  const resources = render(accountPlan(local, { name: "one" }));
  expect(resources.map((r) => r.kind)).not.toContain("Ingress");
  expect(resources.map((r) => r.kind)).not.toContain("Certificate");
  expect(JSON.stringify(resources)).not.toContain("POCKETCODER_PUBLIC_VIEWS");
  const controller = resources.find((r) => r.kind === "NetworkPolicy" && r.metadata.name === "controller")?.spec;
  expect((controller as { ingress: unknown[] }).ingress).toHaveLength(1);
});

test("public hosts keep the API, views and embedding parents on separate registrable domains", () => {
  const hosts = config.publicHosts as NonNullable<typeof config.publicHosts>;
  expect(() =>
    ManagerConfigSchema.parse({ ...config, publicHosts: { ...hosts, viewOrigin: "https://embed.datazine.app" } }),
  ).toThrow();
  expect(() => ManagerConfigSchema.parse({ ...config, publicHosts: { ...hosts, trustedIngress: [] } })).toThrow();
  expect(() => accountPlan(config, { name: "one", parents: ["https://app.kaset.dev"] })).toThrow();
  const { publicHosts: _, ...local } = config;
  expect(() => accountPlan(local, { name: "one", parents: ["https://app.example.org"] })).toThrow();
});
