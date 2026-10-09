const DIGEST_A = `sha256:${"1234567890abcdef".repeat(4)}`;
const DIGEST_B = `sha256:${"abcdef0123456789".repeat(4)}`;
const DIGEST_C = `sha256:${"13579bdf02468ace".repeat(4)}`;
const DIGEST_D = `sha256:${"2468ace013579bdf".repeat(4)}`;

export function manifest(documents: unknown[]) {
  return documents.map((document) => Bun.YAML.stringify(document)).join("\n---\n");
}

export function validDocuments() {
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
            volumes: [{ name: "controller-data", persistentVolumeClaim: { claimName: "pocketcoder-data" } }],
            containers: [
              {
                name: "server",
                image: serverImage,
                env: [{ name: "POCKETCODER_DIR", value: "/var/lib/pocketcoder-controller/pc_data" }],
                volumeMounts: [{ name: "controller-data", mountPath: "/var/lib/pocketcoder-controller" }],
                readinessProbe: { httpGet: { path: "/readyz" } },
                livenessProbe: { httpGet: { path: "/livez" } },
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
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "pocketcoder-admin" },
      spec: { containers: [{ name: "admin", image: serverImage }] },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "pocketcoder-data" },
      spec: { accessModes: ["ReadWriteOnce"], storageClassName: "do-block-storage" },
    },
  ];
}
