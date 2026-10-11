import { expect, test } from "bun:test";
import {
  createDigitalOceanStorage,
  digitalOceanCollection,
  digitalOceanSnapshot,
  digitalOceanSnapshotsAbsent,
  digitalOceanVolume,
  digitalOceanVolumeId,
} from "./digitalocean";

// Identity fields from the official volume and volume-snapshot examples.
const volumeId = "89bcc42f-85cf-11e6-a004-000f53315871";
const otherId = "82a48a18-873f-11e6-96bf-000f53315a41";
const snapshot = {
  id: "fbe805e8-866b-11e6-96bf-000f53315a41",
  resource_id: volumeId,
  resource_type: "volume",
  name: "pvc-01-1595954862243",
};

test("adapter creation requires a finite future credential without making requests", () => {
  for (const expiresAt of [new Date(Number.NaN), new Date(0)]) {
    expect(() => createDigitalOceanStorage({ token: "unused-private-test-value", expiresAt })).toThrow();
  }
  for (const token of ["", "invalid\r\nheader"]) {
    expect(() => createDigitalOceanStorage({ token, expiresAt: new Date(Date.now() + 60_000) })).toThrow();
  }
  expect(
    createDigitalOceanStorage({ token: "unused-private-test-value", expiresAt: new Date(Date.now() + 60_000) }),
  ).toHaveProperty("inventory");
});

test("physical identity uses the current CSI driver and exact provider IDs", () => {
  expect(digitalOceanVolumeId({ driver: "dobs.csi.digitalocean.com", handle: volumeId })).toBe(volumeId);
  expect(digitalOceanVolume({ volume: { id: volumeId, name: "same-name" } }, volumeId).id).toBe(volumeId);
  expect(digitalOceanSnapshot({ snapshot }, volumeId, snapshot.id)).toEqual({
    id: snapshot.id,
    resource_id: volumeId,
    resource_type: "volume",
  });
  expect(() => digitalOceanVolumeId({ driver: "com.digitalocean.csi.dobs", handle: volumeId })).toThrow();
  expect(() => digitalOceanVolumeId({ driver: "dobs.csi.digitalocean.com", handle: "same-name" })).toThrow();
  expect(() => digitalOceanVolume({ volume: { id: otherId, name: "same-name" } }, volumeId)).toThrow();
  expect(() =>
    digitalOceanSnapshot({ snapshot: { ...snapshot, resource_id: otherId } }, volumeId, snapshot.id),
  ).toThrow();
  expect(() =>
    digitalOceanSnapshot({ snapshot: { ...snapshot, resource_type: "droplet" } }, volumeId, snapshot.id),
  ).toThrow();
  expect(() => digitalOceanSnapshot({ snapshot }, volumeId, "different-id")).toThrow();
});

test("documented collection envelopes bind IDs while account-wide totals can change", () => {
  const pages = [
    {
      volumes: [{ id: volumeId }],
      meta: { total: 2 },
      links: { pages: { next: "https://api.digitalocean.com/v2/volumes?page=2" } },
    },
    { volumes: [{ id: otherId }], meta: { total: 2 }, links: {} },
  ];
  expect(digitalOceanCollection(pages, "volumes").map((item) => item.id)).toEqual([volumeId, otherId]);
  expect(digitalOceanCollection([{ snapshots: [snapshot], meta: { total: 1 }, links: {} }], "snapshots")).toEqual([
    { id: snapshot.id, resource_id: volumeId, resource_type: "volume" },
  ]);
  expect(digitalOceanCollection([{ volumes: [], meta: { total: 0 } }], "volumes")).toEqual([]);
  expect(() => digitalOceanCollection([pages[0]], "volumes")).toThrow();
  expect(digitalOceanCollection([pages[0], { volumes: [{ id: volumeId }], meta: { total: 1 } }], "volumes")).toEqual([
    { id: volumeId },
  ]);
  expect(
    digitalOceanCollection([pages[0], { volumes: [{ id: otherId }], meta: { total: 3 } }], "volumes"),
  ).toHaveLength(2);
  expect(() => digitalOceanCollection([{ meta: { total: 0 } }], "volumes")).toThrow();
  expect(() =>
    digitalOceanCollection(
      [{ snapshots: [{ ...snapshot, resource_type: "droplet" }], meta: { total: 1 } }],
      "snapshots",
    ),
  ).toThrow();
  expect(() =>
    digitalOceanCollection(
      [
        {
          snapshots: [snapshot],
          meta: { total: 1 },
          links: { pages: { next: "https://api.digitalocean.com/v2/snapshots?page=2" } },
        },
        { snapshots: [{ ...snapshot, resource_id: otherId }], meta: { total: 1 } },
      ],
      "snapshots",
    ),
  ).toThrow();
});

test("final global snapshot absence checks both exact resource and retained IDs", () => {
  const inventory = { provider: "digitalocean", volumeId, snapshotIds: [snapshot.id] };
  expect(() => digitalOceanSnapshotsAbsent([], inventory)).not.toThrow();
  expect(() =>
    digitalOceanSnapshotsAbsent([{ ...snapshot, id: "other-snapshot", resource_id: otherId }], inventory),
  ).not.toThrow();
  expect(() => digitalOceanSnapshotsAbsent([{ ...snapshot, id: "new-unretained-snapshot" }], inventory)).toThrow();
  expect(() => digitalOceanSnapshotsAbsent([{ ...snapshot, resource_id: otherId }], inventory)).toThrow();
  expect(() => digitalOceanSnapshotsAbsent([], { ...inventory, provider: "unknown" })).toThrow();
  expect(() => digitalOceanSnapshotsAbsent([], { ...inventory, snapshotIds: [snapshot.id, snapshot.id] })).toThrow();
});
