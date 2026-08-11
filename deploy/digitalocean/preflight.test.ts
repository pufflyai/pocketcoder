import { describe, expect, test } from "bun:test";
import { validateRenderedManifest } from "./preflight";

const DIGEST_A = `sha256:${"1234567890abcdef".repeat(4)}`;
const DIGEST_B = `sha256:${"abcdef0123456789".repeat(4)}`;
const DIGEST_C = `sha256:${"13579bdf02468ace".repeat(4)}`;
const DIGEST_D = `sha256:${"2468ace013579bdf".repeat(4)}`;

interface DeploymentFixture {
  spec: { template: { spec: { containers: Array<{ image: string }> } } };
}

interface ConfigMapFixture {
  data: Record<string, string>;
}

interface ServiceFixture {
  metadata: { name: string; annotations?: Record<string, string> };
  spec: Record<string, unknown>;
}

interface JobFixture {
  spec: {
    template: {
      spec: {
        automountServiceAccountToken: boolean;
        securityContext: { runAsUser: number; runAsGroup: number; runAsNonRoot: boolean };
      };
    };
  };
}

function manifest(documents: unknown[]) {
  return documents.map((document) => Bun.YAML.stringify(document)).join("\n---\n");
}

function validDocuments() {
  const serverImage = `registry.example/pocketcoder-server@${DIGEST_A}`;
  const workspaceImage = `registry.example/pocketcoder-workspace@${DIGEST_B}`;
  return [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "pocketcoder-controller" } },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "pocketcoder-workspace" },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolume",
      metadata: { name: "pocketcoder-digitalocean-nfs" },
      spec: {
        accessModes: ["ReadWriteMany"],
        persistentVolumeReclaimPolicy: "Retain",
        storageClassName: "",
        nfs: { server: "10.10.0.5", path: "/example/share" },
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "pocketcoder-workspaces" },
      spec: { accessModes: ["ReadWriteMany"], storageClassName: "" },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "pocketcoder-server" },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        template: {
          spec: {
            serviceAccountName: "pocketcoder-controller",
            securityContext: { runAsUser: 10_001, runAsGroup: 10_001, runAsNonRoot: true },
            containers: [
              {
                name: "server",
                image: serverImage,
                readinessProbe: { httpGet: { path: "/readyz" } },
                livenessProbe: { httpGet: { path: "/livez" } },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "pocketcoder-migrate" },
      spec: {
        template: {
          spec: {
            automountServiceAccountToken: false,
            securityContext: { runAsUser: 10_001, runAsGroup: 10_001, runAsNonRoot: true },
            containers: [
              {
                name: "migrate",
                image: serverImage,
                command: ["pcd"],
                args: ["db", "migrate"],
                env: [
                  {
                    name: "POCKETCODER_DATABASE_URL",
                    valueFrom: {
                      secretKeyRef: { name: "pocketcoder-server", key: "database-url" },
                    },
                  },
                  { name: "POCKETCODER_DATABASE_SCHEMA", value: "pocketcoder" },
                ],
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "pocketcoder-templates" },
      data: {
        "persistent-echo.json": JSON.stringify({ spec: { image: workspaceImage } }),
        "pi-harness.json": JSON.stringify({
          spec: {
            image: `registry.example/pocketcoder-pi@${DIGEST_C}`,
            agent: {
              env: {
                PI_GATEWAY_URL: "http://pocketcoder-pi-gateway:8080/v1",
                PI_GATEWAY_MODEL: "approved-model",
                PI_GATEWAY_BEARER: "secretRef:pocketcoder-pi-gateway-session/bearer",
              },
            },
          },
        }),
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "pocketcoder-server" },
      spec: { type: "ClusterIP" },
    },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name: "pocketcoder-pi-gateway" },
      automountServiceAccountToken: false,
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "pocketcoder-pi-gateway" },
      spec: {
        replicas: 1,
        template: {
          spec: {
            serviceAccountName: "pocketcoder-pi-gateway",
            automountServiceAccountToken: false,
            securityContext: { runAsUser: 10_001, runAsGroup: 10_001, runAsNonRoot: true },
            containers: [
              {
                name: "gateway",
                image: `registry.example/pocketcoder-pi-gateway@${DIGEST_D}`,
                env: [
                  {
                    name: "OPENAI_API_KEY",
                    valueFrom: {
                      secretKeyRef: {
                        name: "pocketcoder-pi-gateway-session",
                        key: "openai-api-key",
                      },
                    },
                  },
                  {
                    name: "PI_GATEWAY_BEARER",
                    valueFrom: {
                      secretKeyRef: {
                        name: "pocketcoder-pi-gateway-session",
                        key: "bearer",
                      },
                    },
                  },
                  {
                    name: "PI_GATEWAY_EXPIRES_AT",
                    valueFrom: {
                      secretKeyRef: {
                        name: "pocketcoder-pi-gateway-session",
                        key: "expires-at",
                      },
                    },
                  },
                  { name: "PI_GATEWAY_ALLOWED_MODEL", value: "approved-model" },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "pocketcoder-pi-gateway" },
      spec: { type: "ClusterIP" },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "pocketcoder-pi-gateway" },
      spec: {
        podSelector: { matchLabels: { app: "pocketcoder-pi-gateway" } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                podSelector: {
                  matchExpressions: [{ key: "pocketcoder.dev/workspace-id", operator: "Exists" }],
                },
              },
            ],
          },
        ],
      },
    },
  ];
}

describe("DigitalOcean manifest preflight", () => {
  test("accepts the private, digest-pinned deployment contract", () => {
    expect(validateRenderedManifest(manifest(validDocuments()))).toEqual([]);
  });

  test("rejects mutable and obvious placeholder image references", () => {
    const documents = validDocuments();
    const deployment = documents[4] as DeploymentFixture;
    deployment.spec.template.spec.containers[0].image = "registry.example/server:latest";
    const template = documents[6] as ConfigMapFixture;
    template.data["persistent-echo.json"] = JSON.stringify({
      spec: { image: `registry.example/workspace@sha256:${"a".repeat(64)}` },
    });

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("registry.example/server:latest"),
        expect.stringContaining("placeholder digest"),
      ]),
    );
  });

  test("requires certificate configuration and narrow source ranges for public access", () => {
    const documents = validDocuments();
    const service = documents[7] as ServiceFixture;
    service.spec = { type: "LoadBalancer", loadBalancerSourceRanges: ["0.0.0.0/0"] };
    service.metadata.annotations = {
      "service.beta.kubernetes.io/do-loadbalancer-protocol": "https",
      "service.beta.kubernetes.io/do-loadbalancer-certificate-name": "REPLACE_CERTIFICATE",
    };

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("certificate"),
        expect.stringContaining("allow-all"),
      ]),
    );
  });

  test("rejects a privileged migration Job", () => {
    const documents = validDocuments();
    const job = documents[5] as JobFixture;
    job.spec.template.spec.automountServiceAccountToken = true;
    job.spec.template.spec.securityContext.runAsUser = 0;

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("service account token"),
        expect.stringContaining("non-root uid/gid 10001"),
      ]),
    );
  });

  test("requires a digest-pinned Pi image and a hardened session gateway", () => {
    const documents = validDocuments();
    const templates = documents[6] as ConfigMapFixture;
    templates.data["pi-harness.json"] = JSON.stringify({
      spec: {
        image: "registry.example/pocketcoder-pi:latest",
        agent: { env: { PI_GATEWAY_BEARER: "standing-token" } },
      },
    });
    const gateway = documents[9] as DeploymentFixture;
    gateway.spec.template.spec.containers[0].image = "registry.example/gateway:latest";
    const podSpec = gateway.spec.template.spec as unknown as Record<string, unknown>;
    podSpec.automountServiceAccountToken = true;

    expect(validateRenderedManifest(manifest(documents))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pocketcoder-pi:latest"),
        expect.stringContaining("gateway:latest"),
        expect.stringContaining("gateway must disable its service account token"),
        expect.stringContaining("projected session bearer"),
      ]),
    );
  });

  test("requires Pi and the gateway to use the same allowed model", () => {
    const documents = validDocuments();
    const gateway = documents[9] as unknown as {
      spec: {
        template: {
          spec: { containers: Array<{ env: Array<Record<string, unknown>> }> };
        };
      };
    };
    const model = gateway.spec.template.spec.containers[0]?.env.find(
      (entry) => entry.name === "PI_GATEWAY_ALLOWED_MODEL",
    );
    if (model) model.value = "different-model";

    expect(validateRenderedManifest(manifest(documents))).toContain(
      "Pi and gateway must use the same allowed model",
    );
  });
});
