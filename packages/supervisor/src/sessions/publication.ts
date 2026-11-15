import { basename } from "node:path";
import {
  canonicalJson,
  digestOf,
  type NativePublicationPolicy,
  type ProducerPublication,
  ProducerPublicationObjectSchema,
  sha256Hex,
} from "@pstdio/pocketcoder-contracts";
import { z } from "zod";
import { publicationFile } from "./publication-file";

export const PublicationSelectionSchema = ProducerPublicationObjectSchema.pick({
  name: true,
  mediaType: true,
  publicationId: true,
})
  .partial({ name: true, publicationId: true })
  .extend({ path: z.string().min(1).max(4096) });
export type PublicationSelection = z.infer<typeof PublicationSelectionSchema>;

export function selectPublication(
  raw: PublicationSelection,
  policy: NativePublicationPolicy,
  publication: ProducerPublication,
) {
  const input = PublicationSelectionSchema.parse(raw);
  const name = input.name ?? basename(input.path);
  if (
    !name.isWellFormed() ||
    /[/\\]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    name === "." ||
    name === ".."
  )
    throw new Error("Publication name must be one safe filename");
  const hash = digestOf({ path: input.path, name, mediaType: input.mediaType }).slice(7);
  const publicationId =
    input.publicationId ??
    `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const known = publication.objects.find((object) => object.publicationId === publicationId);
  if (!known && publication.objects.length >= policy.files) throw new Error("Publication file limit exceeded");
  const used = publication.objects.reduce((total, object) => total + object.sizeBytes, 0);
  const bytes = publicationFile(input.path, policy.roots, policy.bytes - used + (known?.sizeBytes ?? 0));
  const object = ProducerPublicationObjectSchema.parse({
    publicationId,
    name,
    mediaType: input.mediaType,
    sizeBytes: bytes.length,
    digest: `sha256:${sha256Hex(bytes)}`,
    contentBase64: bytes.toString("base64"),
  });
  if (known && canonicalJson(known) !== canonicalJson(object)) throw new Error("Publication identity changed");
  if (!known) publication.objects.push(object);
  const { contentBase64: _, ...descriptor } = object;
  return { ...descriptor, state: "staged" as const };
}
