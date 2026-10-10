import type { Account } from "../database/store";
import { accountController } from "./controller";
import { accountNetworkPolicies } from "./network";
export function accountManifests(account: Account, apiAddresses: string[]) {
  const labels = { "pocketcoder.dev/account": account.id };
  const metadata = (name: string) => ({ name, namespace: account.namespace, labels });
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: account.namespace, labels } },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("account"),
      spec: {
        hard: {
          "requests.cpu": "4",
          "limits.cpu": "4",
          "requests.memory": "4Gi",
          "limits.memory": "4Gi",
          "requests.storage": "10Gi",
          "requests.ephemeral-storage": "4Gi",
          "limits.ephemeral-storage": "4Gi",
          pods: "20",
          persistentvolumeclaims: "1",
          secrets: "100",
        },
      },
    },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata("controller") },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: metadata("workspace"), automountServiceAccountToken: false },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "Role",
      metadata: metadata("controller"),
      rules: [
        { apiGroups: ["batch"], resources: ["jobs"], verbs: ["create", "get", "list", "patch", "delete"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "patch", "delete"] },
        { apiGroups: [""], resources: ["secrets"], verbs: ["create", "get", "patch", "delete"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: metadata("controller"),
      subjects: [{ kind: "ServiceAccount", name: "controller", namespace: account.namespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "controller" },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: `${account.namespace}-nodes`, labels },
      rules: [
        { apiGroups: [""], resources: ["nodes"], verbs: ["get"] },
        { apiGroups: ["node.k8s.io"], resources: ["runtimeclasses"], verbs: ["get"] },
      ],
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: `${account.namespace}-nodes`, labels },
      subjects: [{ kind: "ServiceAccount", name: "controller", namespace: account.namespace }],
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: `${account.namespace}-nodes` },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: metadata("controller-data"),
      spec: {
        accessModes: ["ReadWriteOnce"],
        ...(account.plan.storageClassName ? { storageClassName: account.plan.storageClassName } : {}),
        resources: { requests: { storage: "10Gi" } },
      },
    },
    ...accountNetworkPolicies(account, apiAddresses),
    ...accountController(account),
  ];
}
