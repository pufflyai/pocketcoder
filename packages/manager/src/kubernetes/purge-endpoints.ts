import { z } from "zod";
import { PublicEndpoints } from "../purge/physical-state";
import type { PhysicalStorage, PurgeTarget } from "../purge/provider-types";
import type { kube } from "./command";
import { accountLabel } from "./public-hosts";

const Owned = z.object({
  metadata: z.object({ uid: z.uuid(), labels: z.record(z.string(), z.string()).optional() }),
});
const Ingress = z.object({ spec: z.object({ rules: z.array(z.object({ host: z.string().min(1) })).min(1) }) });

function ownedUid(target: PurgeTarget, value: unknown) {
  const { metadata } = Owned.parse(value);
  if (metadata.labels?.["pocketcoder.dev/account"] !== target.id)
    throw new Error("Account public host identity differs.");
  return metadata.uid;
}

export function accountEndpoints(target: PurgeTarget, ingress: unknown, certificate: unknown, secret: unknown) {
  return {
    ingressUid: ownedUid(target, ingress),
    certificateUid: ownedUid(target, certificate),
    secretUid: secret ? ownedUid(target, secret) : null,
    hosts: Ingress.parse(ingress).spec.rules.map((rule) => rule.host),
  };
}

// Only the Ingress publishes DNS, and the manager applies the Certificate before it. Without
// the Ingress, namespace deletion removes everything public, and clusters without public hosts
// need no cert-manager API.
export async function inventoryAccountEndpoints(command: typeof kube, target: PurgeTarget, storage: PhysicalStorage) {
  const read = async (kind: string, name: string) => {
    const output = await command(["-n", target.namespace, "get", kind, name, "--ignore-not-found", "-o", "json"]);
    return output ? (JSON.parse(output) as unknown) : null;
  };
  const ingress = await read("ingress", "public-hosts");
  if (!ingress) return null;
  const certificate = await read("certificates.cert-manager.io", "public-hosts");
  const endpoints = accountEndpoints(target, ingress, certificate, await read("secret", "public-hosts-tls"));
  return PublicEndpoints.parse({
    ...endpoints,
    records: await storage.dnsRecords(accountLabel(target.id), endpoints.hosts),
  });
}

// Namespace deletion has already removed the Ingress, Certificate and Secret. external-dns then
// deletes the account's DNS records, so success waits until DigitalOcean no longer lists them.
export async function verifyEndpointsRemoved(
  target: PurgeTarget,
  storage: PhysicalStorage,
  endpoints: z.infer<typeof PublicEndpoints> | null,
) {
  if (!endpoints) return null;
  await storage.dnsAbsent(accountLabel(target.id), endpoints.hosts, endpoints.records);
  return { ...endpoints, verifiedAt: new Date().toISOString() };
}
