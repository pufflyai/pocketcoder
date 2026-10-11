import { z } from "zod";

export const NodeIdentity = z.strictObject({ uid: z.uuid(), providerId: z.string().min(1) });
export const PurgeTargets = z.array(
  z.strictObject({ accountId: z.uuid(), namespaceUid: z.uuid().nullable(), neverStarted: z.boolean() }),
);
export const ControllerInventory = z.strictObject({
  namespaceUid: z.uuid(),
  deploymentUid: z.uuid(),
  controllers: z
    .array(z.strictObject({ uid: z.uuid(), replicaSetUid: z.uuid(), node: NodeIdentity.nullable() }))
    .min(1),
  rbac: z.strictObject({ clusterRoleUid: z.uuid(), clusterRoleBindingUid: z.uuid() }),
});
export const ContainerExit = z.strictObject({
  id: z.string().min(1),
  exitCode: z.number().int(),
  finishedAt: z.iso.datetime(),
});
export const PodExit = z.strictObject({
  uid: z.uuid(),
  node: NodeIdentity.nullable(),
  containers: z.array(ContainerExit),
});
export const RuntimeExit = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["workspace", "warm"]),
  admitted: z.boolean(),
  jobUid: z.uuid().nullable(),
  inputUid: z.uuid().nullable(),
  pods: z.array(PodExit),
});
export const PurgeDrain = z.strictObject({
  accountId: z.uuid(),
  operationId: z.uuid(),
  keysRevokedAt: z.iso.datetime(),
  runtimes: z.array(RuntimeExit),
});
export const ControllerExits = z.strictObject({ deploymentUid: z.uuid(), pods: z.array(PodExit).min(1) });
// The account's own Ingress, Certificate and TLS Secret, and the DNS records published for its hosts.
export const PublicEndpoints = z.strictObject({
  ingressUid: z.uuid(),
  certificateUid: z.uuid(),
  // cert-manager writes the Secret only after the first issuance.
  secretUid: z.uuid().nullable(),
  hosts: z.array(z.string().min(1)).min(1),
  records: z.array(
    z.strictObject({
      zone: z.string().min(1),
      id: z.number().int().positive(),
      type: z.string().min(1),
      name: z.string().min(1),
    }),
  ),
});
export const PurgeInventory = z.strictObject({
  accountId: z.uuid(),
  namespaceUid: z.uuid(),
  volumes: z
    .array(
      z.strictObject({
        claimUid: z.uuid(),
        persistentVolumeUid: z.uuid(),
        attachmentUids: z.array(z.uuid()),
        storage: z.strictObject({ driver: z.string().min(1), handle: z.string().min(1) }),
        provider: z.strictObject({
          provider: z.string().min(1),
          volumeId: z.string().min(1),
          snapshotIds: z.array(z.string().min(1)),
        }),
        node: NodeIdentity.nullable(),
      }),
    )
    .min(1),
  // Accounts without public hosts have no endpoints beyond their namespace.
  endpoints: PublicEndpoints.nullable(),
});
export const PhysicalDeleted = z.strictObject({
  namespaceUid: z.uuid(),
  volumes: z.array(
    z.strictObject({
      provider: z.string().min(1),
      volumeId: z.string().min(1),
      snapshotIds: z.array(z.string().min(1)),
      verifiedAt: z.iso.datetime(),
    }),
  ),
  rbac: ControllerInventory.shape.rbac,
  endpoints: PublicEndpoints.extend({ verifiedAt: z.iso.datetime() }).nullable(),
});
