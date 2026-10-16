import { z } from "zod";

const providerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Droplet = z.object({
  droplet: z.object({
    id: providerId,
    status: z.string(),
    locked: z.boolean(),
    region: z.object({ slug: z.string() }),
  }),
});
type ManagerHostIdentity = { provider: "digitalocean"; dropletId: number; region: string };
const closed = () => new Error("Manager host fencing is incomplete; recovery stays closed.");
export function digitalOceanManagerFence(
  host: ManagerHostIdentity,
  actionId: number,
  snapshotAt: string,
  actionBody: unknown,
  dropletBody: unknown,
) {
  const { action } = z
    .object({
      action: z.object({
        id: providerId,
        resource_id: providerId,
        resource_type: z.literal("droplet"),
        type: z.literal("power_off"),
        status: z.literal("completed"),
        completed_at: z.iso.datetime({ offset: true }),
      }),
    })
    .parse(actionBody);
  const { droplet } = Droplet.parse(dropletBody);
  const completed = Date.parse(action.completed_at);
  const snapshot = Date.parse(z.iso.datetime({ offset: true }).parse(snapshotAt));
  if (
    action.id !== actionId ||
    action.resource_id !== host.dropletId ||
    completed <= snapshot ||
    completed > Date.now() ||
    droplet.id !== host.dropletId ||
    droplet.region.slug !== host.region ||
    droplet.status !== "off" ||
    droplet.locked
  )
    throw closed();
}
