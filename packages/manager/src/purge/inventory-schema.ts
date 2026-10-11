import { z } from "zod";

export const PhysicalInventorySchema = z.strictObject({
  provider: z.enum(["digitalocean", "kind-owned-hostpath"]),
  volumeId: z.string().min(1),
  snapshotIds: z.array(z.string().min(1)),
});

export const PurgeInventorySchema = z.strictObject({
  namespaceUid: z.uuid(),
  volumes: z.array(
    z.strictObject({
      claimUid: z.uuid(),
      persistentVolumeUid: z.uuid(),
      storage: z.strictObject({ driver: z.string().min(1), handle: z.string().min(1) }),
      provider: PhysicalInventorySchema,
    }),
  ),
  // A shared wildcard route and certificate belong to the deployment, not this account.
  endpoints: z.strictObject({
    scope: z.literal("shared"),
    dnsIds: z.tuple([]),
    certificateIds: z.tuple([]),
  }),
});
