import { imageRoles } from "./image-policy";
import { imageCommand } from "./image-tools";

export function releaseImageTags(registry: string, releaseTag: string, options: { latest: boolean }) {
  if (!/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/.test(registry)) throw new Error("Use the project's GHCR repository");
  const version = /^v(\d+\.\d+\.\d+)$/.exec(releaseTag)?.[1];
  if (!version) throw new Error(`Expected a release tag like v0.9.0, got ${releaseTag}`);
  return imageRoles.map((role) => ({
    role,
    tags: [`${registry}/${role}:${version}`, ...(options.latest ? [`${registry}/${role}:latest`] : [])],
  }));
}

// Release tags point at the scanned candidate digests built from the released commit; nothing is rebuilt.
export async function releaseImages(registry: string, releaseTag: string, options: { latest: boolean }) {
  const plan = releaseImageTags(registry, releaseTag, options);
  const commit = await imageCommand(["git", "rev-parse", `${releaseTag}^{commit}`], { capture: true });
  const images = [];
  // Resolve every role before the first registry write, so a missing candidate leaves all tags untouched.
  for (const entry of plan) {
    const candidate = `${registry}/${entry.role}:candidate-${commit}`;
    const manifest = JSON.parse(
      await imageCommand(["docker", "buildx", "imagetools", "inspect", candidate, "--format", "{{json .Manifest}}"], {
        capture: true,
      }),
    );
    images.push({ ...entry, image: `${registry}/${entry.role}@${manifest.digest}` });
  }
  for (const { tags, image } of images)
    await imageCommand(["docker", "buildx", "imagetools", "create", ...tags.flatMap((tag) => ["--tag", tag]), image]);
  console.log(JSON.stringify({ releaseTag, commit, images }, null, 2));
}

if (import.meta.main) {
  const [releaseTag, registry, flag] = process.argv.slice(2);
  if (!releaseTag || !registry) throw new Error("Usage: release-images.ts <vX.Y.Z> <ghcr.io/owner/repo> [--no-latest]");
  await releaseImages(registry, releaseTag, { latest: flag !== "--no-latest" });
}
