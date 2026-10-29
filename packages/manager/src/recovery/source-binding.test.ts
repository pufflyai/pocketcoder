import { expect, test } from "bun:test";
import { canonicalSourceWriter, validateSourceVolume } from "./source-binding";

const binding = {
  provider: "digitalocean" as const,
  hostId: 608728570,
  region: "ams3",
  volumeId: "5beb29f8-c6e9-11f1-8917-de2f9bb3d1bb",
  volumeName: "pocketcoder-pc103-manager",
};
const droplet = {
  droplet: {
    id: binding.hostId,
    status: "active",
    locked: false,
    region: { slug: "ams3" },
    volume_ids: [binding.volumeId],
  },
};
const volume = {
  volume: { id: binding.volumeId, name: binding.volumeName, region: { slug: "ams3" }, droplet_ids: [binding.hostId] },
};
const writer = {
  format: "pocketcoder-source-writer/v1" as const,
  directory: "/mnt/pc103-manager/manager_data",
  root: { device: "2048", inode: "65537" },
  lock: { device: "2048", inode: "65538" },
};
const observed = { ...writer, root: { ...writer.root, device: "2064" }, lock: { ...writer.lock, device: "2064" } };

test("the exact provider volume authorizes a device-number change, while retaining the canonical claim", () => {
  expect(validateSourceVolume(binding, String(binding.hostId), "ams3", droplet, volume)).toEqual(binding);
  expect(canonicalSourceWriter(writer, observed, "2064")).toEqual(writer);
});
test("cloned volumes, changed hosts, wrong regions and ambiguous attachments fail", () => {
  for (const altered of [
    { ...binding, hostId: binding.hostId + 1 },
    { ...binding, volumeId: "6beb29f8-c6e9-11f1-8917-de2f9bb3d1bb" },
    { ...binding, region: "ams2" },
    { ...binding, volumeName: "clone" },
  ])
    expect(() => validateSourceVolume(altered, String(binding.hostId), "ams3", droplet, volume)).toThrow();
  expect(() =>
    validateSourceVolume(binding, String(binding.hostId), "ams3", droplet, {
      volume: { ...volume.volume, droplet_ids: [binding.hostId, 99] },
    }),
  ).toThrow();
  expect(() =>
    validateSourceVolume(
      binding,
      String(binding.hostId),
      "ams3",
      { droplet: { ...droplet.droplet, locked: true } },
      volume,
    ),
  ).toThrow();
});
test("normalization cannot hide a changed inode, path, device or lock", () => {
  for (const altered of [
    { ...observed, directory: "/another" },
    { ...observed, root: { ...observed.root, inode: "2" } },
    { ...observed, lock: { ...observed.lock, inode: "2" } },
    { ...observed, lock: { ...observed.lock, device: "2048" } },
  ])
    expect(() => canonicalSourceWriter(writer, altered, "2064")).toThrow();
  expect(() => canonicalSourceWriter(writer, observed, "2048")).toThrow();
});
