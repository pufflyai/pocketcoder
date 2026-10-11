import type { OffNodeBackupReceipt } from "@pstdio/pocketcoder-db/off-node";
import { EVIDENCE_FINALIZER } from "@pstdio/pocketcoder-drivers";
import type { Account } from "../database/store";
import { installOffNodeFiles, offNodeFileMount, offNodeSecretVolume } from "./off-node-files";

export const restoredVolumeName = (operationId: string) => `controller-restore-${operationId}`;
export const restoreJobName = (operationId: string) => `restore-${operationId}`;

export function restoreManifests(account: Account, operationId: string, receipt: OffNodeBackupReceipt) {
  const labels = { "pocketcoder.dev/account": account.id, "pocketcoder.dev/restore": operationId };
  const metadata = (name: string) => ({ name, namespace: account.namespace, labels });
  const mounts = [
    { name: "private", mountPath: "/private" },
    { name: "tmp", mountPath: "/tmp" },
  ];
  const securityContext = {
    runAsUser: 10001,
    runAsGroup: 10001,
    runAsNonRoot: true,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  };
  const resources = {
    requests: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "128Mi" },
    limits: { cpu: "500m", memory: "512Mi", "ephemeral-storage": "128Mi" },
  };
  const name = restoreJobName(operationId);
  return [
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: metadata(restoredVolumeName(operationId)),
      spec: {
        accessModes: ["ReadWriteOnce"],
        ...(account.plan.storageClassName ? { storageClassName: account.plan.storageClassName } : {}),
        resources: { requests: { storage: "10Gi" } },
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: metadata(name),
      immutable: true,
      data: { "receipt.json": Buffer.from(JSON.stringify(receipt)).toString("base64") },
    },
    {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: metadata(name),
      spec: {
        backoffLimit: 0,
        template: {
          metadata: { labels: { ...labels, "pocketcoder.dev/role": "controller" }, finalizers: [EVIDENCE_FINALIZER] },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            securityContext: { fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
            volumes: [
              { name: "private", persistentVolumeClaim: { claimName: restoredVolumeName(operationId) } },
              { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } },
              offNodeSecretVolume,
              { name: "receipt", secret: { secretName: name, defaultMode: 0o400 } },
            ],
            initContainers: [
              {
                name: "private-files",
                image: account.plan.controllerImage,
                command: [
                  "bun",
                  "-e",
                  `const f=await import('node:fs/promises');await f.chown('/private',0,0);await f.chmod('/private',0o700);${installOffNodeFiles};await f.rm('/private/.restore-receipt.tmp',{force:true});await f.copyFile('/receipt/receipt.json','/private/.restore-receipt.tmp');await f.chmod('/private/.restore-receipt.tmp',0o600);await f.chown('/private/.restore-receipt.tmp',10001,10001);await f.rename('/private/.restore-receipt.tmp','/private/restore-receipt.json');await f.chown('/private',10001,10001)`,
                ],
                volumeMounts: [...mounts, offNodeFileMount, { name: "receipt", mountPath: "/receipt", readOnly: true }],
                resources,
                securityContext: {
                  ...securityContext,
                  runAsUser: 0,
                  runAsNonRoot: false,
                  capabilities: { drop: ["ALL"], add: ["CHOWN", "FOWNER"] },
                },
              },
            ],
            containers: [
              {
                name: "restore",
                image: account.plan.controllerImage,
                command: [
                  "bun",
                  "/opt/pocketcoder/cli/index.js",
                  "backup",
                  "restore-off-node",
                  "/private/restore-receipt.json",
                  "--dir",
                  "/private/pc_data",
                  "--journal-dir",
                  "/private/pc_data-journal",
                  "--checkpoint-dir",
                  "/private/checkpoints",
                  "--off-node-config",
                  "/private/off-node/config.json",
                  "--operation-id",
                  operationId,
                ],
                volumeMounts: mounts,
                resources,
                securityContext,
              },
            ],
          },
        },
      },
    },
  ];
}
