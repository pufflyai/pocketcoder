import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { accountPlan, ManagerConfigSchema } from "../config";
import type { Account } from "../database/store";
import { PurgeInventory } from "../purge/physical-state";
import { publicHostManifests } from "./public-hosts";
import { accountEndpoints } from "./purge-endpoints";

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
const account: Account = {
  id,
  name: "one",
  namespace: `pc-account-${label}`,
  requestId: "one",
  requestDigest: "digest",
  plan: accountPlan(config, { name: "one" }),
  state: "ready",
  volumeName: "controller-data",
  bootstrapRequestId: null,
  createdAt: new Date(),
};
const target = { id, namespace: account.namespace };
// The API server adds a UID to each applied object; cert-manager copies the template labels to the Secret.
const stored = (resource: object) => {
  const value = structuredClone(resource) as { metadata: Record<string, unknown> };
  value.metadata.uid = randomUUID();
  return value as typeof value & { metadata: { uid: string } };
};
const [certificate, ingress] = publicHostManifests(account).map(stored);
if (!certificate || !ingress) throw new Error("Public host manifests are missing.");
const secret = stored({
  apiVersion: "v1",
  kind: "Secret",
  type: "kubernetes.io/tls",
  metadata: { name: "public-hosts-tls", namespace: account.namespace, labels: { "pocketcoder.dev/account": id } },
});
const hosts = [`${label}.pocketcoder.datazine.app`, `*.${label}.embed.kaset.dev`];

test("an account with public hosts inventories its route, certificate, TLS Secret and published hosts", () => {
  expect(accountEndpoints(target, ingress, certificate, secret)).toEqual({
    ingressUid: ingress.metadata.uid,
    certificateUid: certificate.metadata.uid,
    secretUid: secret.metadata.uid,
    hosts,
  });
  // cert-manager writes the Secret only after the first issuance.
  expect(accountEndpoints(target, ingress, certificate, null).secretUid).toBeNull();
});

test("public host objects must belong to the purged account", () => {
  const foreign = (resource: typeof secret) => ({
    ...resource,
    metadata: { ...resource.metadata, labels: { "pocketcoder.dev/account": randomUUID() } },
  });
  expect(() => accountEndpoints(target, foreign(ingress), certificate, secret)).toThrow("differs");
  expect(() => accountEndpoints(target, ingress, foreign(certificate), secret)).toThrow("differs");
  expect(() => accountEndpoints(target, ingress, certificate, foreign(secret))).toThrow("differs");
  expect(() => accountEndpoints(target, ingress, null, secret)).toThrow();
});

test("the retained inventory lists account endpoints or none", () => {
  const inventory = {
    accountId: id,
    namespaceUid: randomUUID(),
    volumes: [
      {
        claimUid: randomUUID(),
        persistentVolumeUid: randomUUID(),
        attachmentUids: [],
        storage: { driver: "dobs.csi.digitalocean.com", handle: randomUUID() },
        provider: { provider: "digitalocean", volumeId: randomUUID(), snapshotIds: [] },
        node: null,
      },
    ],
    endpoints: {
      ...accountEndpoints(target, ingress, certificate, secret),
      records: [{ zone: "datazine.app", id: 41, type: "A", name: `${label}.pocketcoder` }],
    },
  };
  expect(PurgeInventory.parse(inventory)).toEqual(inventory);
  expect(PurgeInventory.parse({ ...inventory, endpoints: null }).endpoints).toBeNull();
});
