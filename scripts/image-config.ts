import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { imageCommand } from "./image-tools";

export async function imageArchiveConfigDigest(archive: string) {
  const [manifest] = JSON.parse(await imageCommand(["tar", "-xOf", archive, "manifest.json"], { capture: true }));
  const config = await imageCommand(["tar", "-xOf", archive, manifest.Config], { capture: true, trim: false });
  return `sha256:${createHash("sha256").update(config).digest("hex")}`;
}

// Docker's ID may identify a config or an OCI index, depending on its image
// store. The saved configuration bytes give Kind a portable identity check.
export async function dockerImageConfigDigest(image: string, directory: string) {
  const archive = join(directory, "identity.tar");
  try {
    await imageCommand(["docker", "save", "--output", archive, image]);
    return await imageArchiveConfigDigest(archive);
  } finally {
    await rm(archive, { force: true });
  }
}
