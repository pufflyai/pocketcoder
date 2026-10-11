import type { Account } from "../database/store";
import { installOffNodeFiles, offNodeFileMount, offNodeSecretVolume } from "./off-node-files";
export function accountController(account: Account, nodeName?: string) {
  const labels = { "pocketcoder.dev/account": account.id, "pocketcoder.dev/role": "controller" };
  const image = account.plan.controllerImage;
  return [
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "controller", namespace: account.namespace, labels },
      spec: {
        selector: labels,
        ports: [
          { name: "http", port: 8090, targetPort: 8090 },
          { name: "agent", port: 8091, targetPort: 8091 },
        ],
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "controller", namespace: account.namespace, labels },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            ...(nodeName ? { nodeName } : {}),
            serviceAccountName: "controller",
            securityContext: { fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
            volumes: [
              { name: "private", persistentVolumeClaim: { claimName: account.volumeName } },
              ...(account.plan.offNodeBackups ? [offNodeSecretVolume] : []),
              { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "32Mi" } },
            ],
            initContainers: [
              {
                name: "private-storage",
                image,
                command: [
                  "bun",
                  "-e",
                  `const f=await import('node:fs/promises');await f.chown('/private',0,0);await f.chmod('/private',0o700);${account.plan.offNodeBackups ? `${installOffNodeFiles};` : ""}await f.chown('/private',10001,10001)`,
                ],
                volumeMounts: [
                  { name: "private", mountPath: "/private" },
                  ...(account.plan.offNodeBackups ? [offNodeFileMount] : []),
                ],
                resources: {
                  requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "64Mi" },
                  limits: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "64Mi" },
                },
                securityContext: {
                  runAsUser: 0,
                  runAsNonRoot: false,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
                },
              },
            ],
            containers: [
              {
                name: "controller",
                image,
                imagePullPolicy: "IfNotPresent",
                env: Object.entries({
                  ...(account.plan.offNodeBackups
                    ? { POCKETCODER_OFF_NODE_CONFIG: "/private/off-node/config.json" }
                    : {}),
                  POCKETCODER_DIR: "/private/pc_data",
                  POCKETCODER_HTTP: "0.0.0.0:8090",
                  POCKETCODER_AGENT_HTTP: "0.0.0.0:8091",
                  POCKETCODER_DRIVER: "kubernetes",
                  POCKETCODER_KUBERNETES_NAMESPACE: account.namespace,
                  POCKETCODER_KUBERNETES_RUNTIME_CLASS: account.plan.runtimeClassName,
                  POCKETCODER_KUBERNETES_SERVICE_ACCOUNT: "workspace",
                  POCKETCODER_STORAGE_BACKEND: "controller-archive",
                  POCKETCODER_CHECKPOINT_DIR: "/private/checkpoints",
                  POCKETCODER_MAX_ACTIVE_WORKSPACES: "3",
                  POCKETCODER_WORKSPACE_SERVER_URL: `http://controller.${account.namespace}.svc:8091`,
                }).map(([name, value]) => ({ name, value })),
                volumeMounts: [
                  { name: "private", mountPath: "/private" },
                  { name: "tmp", mountPath: "/tmp" },
                ],
                resources: {
                  requests: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "128Mi" },
                },
                securityContext: {
                  runAsUser: 10001,
                  runAsGroup: 10001,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                readinessProbe: { httpGet: { path: "/readyz", port: 8090 }, periodSeconds: 1 },
              },
            ],
          },
        },
      },
    },
  ];
}
