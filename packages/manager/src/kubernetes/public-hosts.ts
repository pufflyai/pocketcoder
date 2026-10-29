import { publicViewConfig } from "@pstdio/pocketcoder-server/public-views";
import type { PublicHosts } from "../config";
import type { Account } from "../database/store";

export const accountLabel = (accountId: string) => accountId.replaceAll("-", "");

// Each account owns one API host and one wildcard view zone. Its route, certificate
// and DNS records live with its namespace, so account removal removes them too.
export function accountOrigins(accountId: string, hosts: Pick<PublicHosts, "apiOrigin" | "viewOrigin">) {
  const label = accountLabel(accountId);
  const prefix = (origin: string) => {
    const url = new URL(origin);
    url.hostname = `${label}.${url.hostname}`;
    return url.origin;
  };
  return { api: prefix(hosts.apiOrigin), views: prefix(hosts.viewOrigin) };
}

export function checkPublicViews(accountId: string, hosts: PublicHosts) {
  const origins = accountOrigins(accountId, hosts);
  const config = publicViewConfig(
    JSON.stringify({
      apiOrigin: origins.api,
      origin: origins.views,
      parents: hosts.parents,
      trustedIngress: hosts.trustedIngress,
    }),
  );
  if (!config) throw new Error("Public views are missing");
  return config;
}

export function publicHostManifests(account: Account) {
  const hosts = account.plan.publicHosts;
  if (!hosts) return [];
  const origins = accountOrigins(account.id, hosts);
  const names = [new URL(origins.api).hostname, `*.${new URL(origins.views).hostname}`];
  const labels = { "pocketcoder.dev/account": account.id };
  const metadata = { name: "public-hosts", namespace: account.namespace, labels };
  const backend = { service: { name: "controller", port: { name: "http" } } };
  return [
    {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata,
      spec: {
        secretName: "public-hosts-tls",
        secretTemplate: { labels },
        dnsNames: names,
        issuerRef: { group: "cert-manager.io", kind: "ClusterIssuer", name: hosts.issuer },
        privateKey: { algorithm: "ECDSA", size: 256, rotationPolicy: "Always" },
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata,
      spec: {
        ingressClassName: hosts.ingressClassName,
        tls: [{ hosts: names, secretName: "public-hosts-tls" }],
        rules: names.map((host) => ({ host, http: { paths: [{ path: "/", pathType: "Prefix", backend }] } })),
      },
    },
  ];
}
