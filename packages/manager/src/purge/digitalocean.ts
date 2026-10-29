import { z } from "zod";
import { digitalOceanApi, digitalOceanPages, pending } from "./digitalocean-api";
import { digitalOceanDns } from "./digitalocean-dns";
import type { PhysicalInventory, PhysicalStorage, PhysicalVolume } from "./provider-types";

const Volume = z.object({ id: z.uuid() });
const Snapshot = z.object({ id: z.string().min(1), resource_id: z.uuid(), resource_type: z.literal("volume") });
type VolumeIdentity = z.infer<typeof Volume>;
type SnapshotIdentity = z.infer<typeof Snapshot>;

export function digitalOceanVolumeId(volume: PhysicalVolume) {
  if (volume.driver !== "dobs.csi.digitalocean.com") throw pending("unknown CSI driver");
  return z.uuid().parse(volume.handle);
}

export function digitalOceanVolume(body: unknown, volumeId: string) {
  const volume = z.object({ volume: Volume }).parse(body).volume;
  if (volume.id !== volumeId) throw pending("volume identity differs");
  return volume;
}

export function digitalOceanSnapshot(body: unknown, volumeId: string, snapshotId: string) {
  const snapshot = z.object({ snapshot: Snapshot }).parse(body).snapshot;
  if (snapshot.id !== snapshotId || snapshot.resource_id !== volumeId) throw pending("snapshot identity differs");
  return snapshot;
}

export function digitalOceanCollection(pages: unknown[], kind: "volumes"): VolumeIdentity[];
export function digitalOceanCollection(pages: unknown[], kind: "snapshots"): SnapshotIdentity[];
export function digitalOceanCollection(pages: unknown[], kind: "volumes" | "snapshots") {
  return kind === "volumes" ? digitalOceanPages(pages, kind, Volume) : digitalOceanPages(pages, kind, Snapshot);
}

function retained(value: PhysicalInventory) {
  const inventory = z
    .object({
      provider: z.literal("digitalocean"),
      volumeId: z.uuid(),
      snapshotIds: z.array(z.string().min(1)),
    })
    .parse(value);
  if (new Set(inventory.snapshotIds).size !== inventory.snapshotIds.length)
    throw pending("retained snapshot IDs repeat");
  return inventory;
}

export function digitalOceanSnapshotsAbsent(items: unknown[], input: PhysicalInventory) {
  const inventory = retained(input);
  for (const item of items) {
    const identity = Snapshot.parse(item);
    if (identity.resource_id === inventory.volumeId || inventory.snapshotIds.includes(identity.id))
      throw pending("snapshot remains in global inventory");
  }
}

export function createDigitalOceanStorage(credential: { token: string; expiresAt: Date }): PhysicalStorage {
  const api = digitalOceanApi(credential);
  const { endpoint, request } = api;
  async function list(path: string, params?: Record<string, string>) {
    const pages = await api.pages(path, params);
    if (!pages) throw pending("inventory endpoint is absent");
    return pages;
  }
  const volumes = async () => digitalOceanCollection(await list("/v2/volumes"), "volumes");
  async function volume(id: string) {
    const body = await request(endpoint(`/v2/volumes/${encodeURIComponent(id)}`), "GET");
    return body === null ? null : digitalOceanVolume(body, id);
  }
  async function snapshot(id: string, volumeId: string) {
    const body = await request(endpoint(`/v2/snapshots/${encodeURIComponent(id)}`), "GET");
    return body === null ? null : digitalOceanSnapshot(body, volumeId, id);
  }
  async function allSnapshots() {
    return digitalOceanCollection(await list("/v2/snapshots", { resource_type: "volume" }), "snapshots");
  }
  async function snapshots(volumeId: string, exists: boolean) {
    const items = exists
      ? digitalOceanCollection(await list(`/v2/volumes/${encodeURIComponent(volumeId)}/snapshots`), "snapshots")
      : await allSnapshots();
    if (exists && items.some((item) => item.resource_id !== volumeId))
      throw pending("associated snapshot identity differs");
    return items.filter((item) => item.resource_id === volumeId);
  }
  async function current(inventory: ReturnType<typeof retained>) {
    const found = await volume(inventory.volumeId);
    if (Boolean(found) !== (await volumes()).some((item) => item.id === inventory.volumeId))
      throw pending("volume GET and list disagree");
    const associated = await snapshots(inventory.volumeId, Boolean(found));
    if (associated.some((item) => !inventory.snapshotIds.includes(item.id)))
      throw pending("unretained associated snapshot exists");
    const present: string[] = [];
    for (const id of inventory.snapshotIds) {
      const foundSnapshot = await snapshot(id, inventory.volumeId);
      if (Boolean(foundSnapshot) !== associated.some((item) => item.id === id))
        throw pending("snapshot GET and list disagree");
      if (foundSnapshot) present.push(id);
    }
    return { volume: found, snapshots: present };
  }
  return {
    async inventory(input) {
      const volumeId = digitalOceanVolumeId(input);
      if (!(await volume(volumeId))) throw pending("volume is absent before inventory capture");
      const associated = await snapshots(volumeId, true);
      return { provider: "digitalocean", volumeId, snapshotIds: associated.map((item) => item.id).sort() };
    },
    async removeAndVerify(input) {
      const inventory = retained(input);
      const before = await current(inventory);
      for (const id of before.snapshots) await request(endpoint(`/v2/snapshots/${encodeURIComponent(id)}`), "DELETE");
      if (before.volume) await request(endpoint(`/v2/volumes/${encodeURIComponent(inventory.volumeId)}`), "DELETE");
      if (await volume(inventory.volumeId)) throw pending("volume remains after deletion");
      for (const id of inventory.snapshotIds)
        if (await snapshot(id, inventory.volumeId)) throw pending("snapshot remains after deletion");
      if ((await volumes()).some((item) => item.id === inventory.volumeId))
        throw pending("volume remains in inventory");
      digitalOceanSnapshotsAbsent(await allSnapshots(), inventory);
      api.lifetime();
      return { ...inventory, verifiedAt: new Date().toISOString() };
    },
    ...digitalOceanDns(api),
  };
}
