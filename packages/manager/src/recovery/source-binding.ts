import { closeSync, constants, openSync, statSync } from "node:fs";
import type { SourceWriter } from "@pstdio/pocketcoder-contracts";
import { readPrivateFile } from "@pstdio/pocketcoder-db/off-node";
import { z } from "zod";
import { digitalOceanApi } from "../purge/digitalocean-api";

export const SourceBindingSchema = z.strictObject({
  provider: z.literal("digitalocean"),
  hostId: z.number().int().positive(),
  region: z.string().min(1),
  volumeId: z.uuid(),
  volumeName: z.string().regex(/^[a-z0-9-]+$/),
});
export type SourceBinding = z.infer<typeof SourceBindingSchema>;
export const SourceConfigSchema = z.strictObject({
  credentialFile: z.string().startsWith("/"),
  blockDevice: z.string().startsWith("/"),
  volumeId: z.uuid(),
  volumeName: z.string().regex(/^[a-z0-9-]+$/),
  migrationFile: z.string().startsWith("/").optional(),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

export function validateSourceVolume(
  binding: SourceBinding,
  metadataId: string,
  metadataRegion: string,
  hostBody: unknown,
  volumeBody: unknown,
) {
  const { droplet } = z
    .object({
      droplet: z.object({
        id: z.number(),
        status: z.literal("active"),
        locked: z.literal(false),
        region: z.object({ slug: z.string() }),
        volume_ids: z.array(z.string()),
      }),
    })
    .parse(hostBody);
  const { volume } = z
    .object({
      volume: z.object({
        id: z.string(),
        name: z.string(),
        region: z.object({ slug: z.string() }),
        droplet_ids: z.array(z.number()),
      }),
    })
    .parse(volumeBody);
  if (
    String(binding.hostId) !== metadataId ||
    binding.region !== metadataRegion ||
    droplet.id !== binding.hostId ||
    droplet.region.slug !== binding.region ||
    !droplet.volume_ids.includes(binding.volumeId) ||
    volume.id !== binding.volumeId ||
    volume.name !== binding.volumeName ||
    volume.region.slug !== binding.region ||
    volume.droplet_ids.length !== 1 ||
    volume.droplet_ids[0] !== binding.hostId
  )
    throw new Error("Manager physical source ownership differs.");
  return binding;
}
export function canonicalSourceWriter(canonical: SourceWriter, observed: SourceWriter, blockDevice: string) {
  if (
    canonical.directory !== observed.directory ||
    canonical.root.inode !== observed.root.inode ||
    canonical.lock.inode !== observed.lock.inode ||
    observed.root.device !== blockDevice ||
    observed.lock.device !== blockDevice
  )
    throw new Error("Manager physical writer identity differs.");
  return canonical;
}
async function metadata(name: "id" | "region") {
  const response = await fetch(`http://169.254.169.254/metadata/v1/${name}`, {
    redirect: "error",
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("Manager source metadata is unavailable.");
  const text = await response.text();
  if (text.length > 4096) throw new Error("Manager source metadata exceeds its bound.");
  return text.trim();
}
export async function verifySource(config: SourceConfig) {
  const credential = z
    .object({ token: z.string().min(1), expiresAt: z.iso.datetime() })
    .parse(JSON.parse((await readPrivateFile(config.credentialFile, 65536)).toString()));
  const api = digitalOceanApi({ token: credential.token, expiresAt: new Date(credential.expiresAt) });
  const [id, region] = await Promise.all([metadata("id"), metadata("region")]);
  const binding = SourceBindingSchema.parse({
    provider: "digitalocean",
    hostId: Number(id),
    region,
    volumeId: config.volumeId,
    volumeName: config.volumeName,
  });
  const [host, volume] = await Promise.all([
    api.request(api.endpoint(`/v2/droplets/${binding.hostId}`), "GET"),
    api.request(api.endpoint(`/v2/volumes/${binding.volumeId}`), "GET"),
  ]);
  validateSourceVolume(binding, id, region, host, volume);
  const device = statSync(config.blockDevice, { bigint: true });
  if (!device.isBlockDevice()) throw new Error("Manager source requires the named block-device stat handle.");
  assertStatOnlyDevice(config.blockDevice);
  api.lifetime();
  return { binding, blockDevice: device.rdev.toString(), api };
}

function assertStatOnlyDevice(path: string) {
  try {
    const descriptor = openSync(path, constants.O_RDONLY);
    closeSync(descriptor);
  } catch (error) {
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  throw new Error("Manager source stat handle must not grant raw-disk access.");
}
