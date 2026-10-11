import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PhysicalInventory, PhysicalStorage, PhysicalVolume } from "./provider-types";

const ORIGIN = "https://api.digitalocean.com";
const Volume = z.object({ id: z.uuid() });
const Snapshot = z.object({ id: z.string().min(1), resource_id: z.uuid(), resource_type: z.literal("volume") });
const Paging = z.object({
  meta: z.object({ total: z.number().int().nonnegative() }),
  links: z.object({ pages: z.object({ next: z.string().url().optional() }).optional() }).optional(),
});
type VolumeIdentity = z.infer<typeof Volume>;
type SnapshotIdentity = z.infer<typeof Snapshot>;
type Kind = "volumes" | "snapshots";
const pending = (reason: string) => new Error(`DigitalOcean cleanup is pending: ${reason}.`);

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

export function digitalOceanNextPage(next: string | undefined, current: URL) {
  if (!next) return null;
  const url = new URL(next);
  if (url.origin !== ORIGIN || url.pathname !== current.pathname || url.username || url.password || url.hash)
    throw pending("next page leaves the inventory endpoint");
  const page = Number(url.searchParams.get("page"));
  if (!Number.isSafeInteger(page) || page !== Number(current.searchParams.get("page")) + 1)
    throw pending("next page is not sequential");
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1 || (key !== "page" && current.searchParams.get(key) !== value))
      throw pending("next page changes inventory scope");
  }
  const result = new URL(current);
  result.searchParams.set("page", String(page));
  return result;
}

export function digitalOceanCollection(pages: unknown[], kind: "volumes"): VolumeIdentity[];
export function digitalOceanCollection(pages: unknown[], kind: "snapshots"): SnapshotIdentity[];
export function digitalOceanCollection(pages: unknown[], kind: Kind) {
  const items = new Map<string, VolumeIdentity | SnapshotIdentity>();
  if (!pages.length) throw pending("inventory has no pages");
  for (const [index, body] of pages.entries()) {
    const paging = Paging.parse(body);
    if (Boolean(paging.links?.pages?.next) !== index < pages.length - 1)
      throw pending("inventory paging is unfinished");
    const page =
      kind === "volumes"
        ? z.object({ volumes: z.array(Volume) }).parse(body).volumes
        : z.object({ snapshots: z.array(Snapshot) }).parse(body).snapshots;
    for (const item of page) {
      const previous = items.get(item.id);
      if (previous && !isDeepStrictEqual(previous, item)) throw pending("repeated provider ID changes identity");
      items.set(item.id, item);
    }
  }
  return [...items.values()];
}

async function json(response: Response) {
  if (!response.body) throw pending("provider response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw pending("provider page exceeds the request bound");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
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
  const token = z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/)
    .parse(credential.token);
  const expiresAt = credential.expiresAt.getTime();
  function lifetime() {
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw pending("provider credential expired");
    return Math.max(1, Math.min(30_000, remaining));
  }
  lifetime();
  async function request(url: URL, method: "GET" | "DELETE") {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(lifetime()),
    });
    try {
      lifetime();
      if (method === "DELETE") {
        if (response.status !== 204) throw pending(`provider DELETE returned ${response.status}`);
        return null;
      }
      if (response.status === 404) return null;
      if (response.status !== 200) throw pending(`provider GET returned ${response.status}`);
      const body = await json(response);
      lifetime();
      return body;
    } finally {
      await response.body?.cancel();
    }
  }
  const endpoint = (path: string) => new URL(path, ORIGIN);
  async function pages(path: string, kind: Kind) {
    let url: URL | null = endpoint(path);
    url.searchParams.set("per_page", "200");
    url.searchParams.set("page", "1");
    if (path === "/v2/snapshots") url.searchParams.set("resource_type", "volume");
    const result: unknown[] = [];
    while (url) {
      const body = await request(url, "GET");
      if (body === null) throw pending("inventory endpoint is absent");
      result.push(body);
      const paging = Paging.parse(body);
      url = digitalOceanNextPage(paging.links?.pages?.next, url);
    }
    if (kind === "volumes") return digitalOceanCollection(result, "volumes");
    return digitalOceanCollection(result, "snapshots");
  }
  async function volume(id: string) {
    const body = await request(endpoint(`/v2/volumes/${encodeURIComponent(id)}`), "GET");
    return body === null ? null : digitalOceanVolume(body, id);
  }
  async function snapshot(id: string, volumeId: string) {
    const body = await request(endpoint(`/v2/snapshots/${encodeURIComponent(id)}`), "GET");
    return body === null ? null : digitalOceanSnapshot(body, volumeId, id);
  }
  async function snapshots(volumeId: string, exists: boolean) {
    const path = exists ? `/v2/volumes/${encodeURIComponent(volumeId)}/snapshots` : "/v2/snapshots";
    const items = await pages(path, "snapshots");
    const result = items.map((item) => Snapshot.parse(item));
    if (exists && result.some((item) => item.resource_id !== volumeId))
      throw pending("associated snapshot identity differs");
    return result.filter((item) => item.resource_id === volumeId);
  }
  async function current(inventory: ReturnType<typeof retained>) {
    const found = await volume(inventory.volumeId);
    const volumes = await pages("/v2/volumes", "volumes");
    if (Boolean(found) !== volumes.some((item) => item.id === inventory.volumeId))
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
      const volumes = await pages("/v2/volumes", "volumes");
      if (volumes.some((item) => item.id === inventory.volumeId)) throw pending("volume remains in inventory");
      const allSnapshots = await pages("/v2/snapshots", "snapshots");
      digitalOceanSnapshotsAbsent(allSnapshots, inventory);
      lifetime();
      return { ...inventory, verifiedAt: new Date().toISOString() };
    },
  };
}
