import { join, resolve } from "node:path";
import type { CandidateImageRecord } from "./candidate-images";
import { dockerImageConfigDigest, imageArchiveConfigDigest } from "./image-config";
import { assertImageScan, assertImageSet, imageArchitectures, imageRoles } from "./image-policy";
import { assertGlibcCoverage } from "./image-rootfs";
import { imageCommand, imageFileHash, imageIdentity } from "./image-tools";

function assertPrimaryEvidence(record: CandidateImageRecord) {
  const primary = `${record.role}-${record.arch}`;
  for (const suffix of [".scan.json", ".sbom.cdx.json", ".scanner.json"])
    if (!record.evidence.some((evidence) => evidence.file === `${primary}${suffix}`))
      throw new Error(`Primary image evidence is missing: ${primary}${suffix}`);
}

async function verifyCandidateEvidence(directory: string, commit: string, record: CandidateImageRecord) {
  if (record.scanner.Version !== "0.74.0" || !record.scanner.VulnerabilityDB.UpdatedAt)
    throw new Error("Image scanner metadata differs");
  if (!record.smoke) throw new Error("Image role smoke is missing");
  assertPrimaryEvidence(record);
  for (const evidence of [record.archive, record.smoke, ...record.evidence]) {
    if ((await imageFileHash(join(directory, evidence.file))) !== evidence.sha256)
      throw new Error(`Evidence checksum differs: ${evidence.file}`);
  }
  if ((await imageArchiveConfigDigest(join(directory, record.archive.file))) !== record.configDigest)
    throw new Error("Archived configuration digest differs");
  assertImageScan(await Bun.file(join(directory, `${record.role}-${record.arch}.scan.json`)).json());
  if (["workspace", "desktop", "browser"].includes(record.role)) {
    const prefix = `${record.role}-${record.arch}.glibc`;
    for (const suffix of [".scan.json", ".sbom.cdx.json", ".scanner.json", ".tar"])
      if (!record.evidence.some((e) => e.file === `${prefix}${suffix}`))
        throw new Error(`GNU runtime evidence is missing: ${prefix}${suffix}`);
    assertGlibcCoverage(await Bun.file(join(directory, `${prefix}.scan.json`)).json());
  }
  const smoke = (await Bun.file(join(directory, record.smoke.file)).json()) as {
    result: string;
    commit: string;
    arch: string;
    images: { role: string; imageId: string; configDigest: string; archive: { file: string; sha256: string } }[];
    logs: { file: string; sha256: string }[];
  };
  const tested = smoke.images.find((image) => image.role === record.role);
  if (
    smoke.result !== "passed" ||
    smoke.commit !== commit ||
    smoke.arch !== record.arch ||
    tested?.imageId !== record.imageId ||
    tested.configDigest !== record.configDigest ||
    tested.archive.sha256 !== record.archive.sha256
  )
    throw new Error("Scanned and tested image identity differs");
  for (const log of smoke.logs)
    if ((await imageFileHash(join(directory, log.file))) !== log.sha256) throw new Error("Smoke log checksum differs");
}

export async function publishCandidateImages(directory: string, commit: string, registry: string) {
  if (!/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9-]+$/.test(registry)) throw new Error("Use the project's GHCR repository");
  const records = await Promise.all(
    imageRoles.flatMap((role) =>
      imageArchitectures.map(
        async (arch) => (await Bun.file(join(directory, `${role}-${arch}.json`)).json()) as CandidateImageRecord,
      ),
    ),
  );
  assertImageSet(records, commit);
  // Validate the complete set before the first registry write.
  for (const record of records) await verifyCandidateEvidence(directory, commit, record);
  const published: {
    role: string;
    arch: string;
    image: string;
    sourceImageId: string;
    loadedImageId: string;
    configDigest: string;
  }[] = [];
  for (const record of records) {
    await imageCommand(["docker", "load", "--input", join(directory, record.archive.file)]);
    const loaded = await imageIdentity(record.tag);
    const configDigest =
      loaded.imageId === record.configDigest ? loaded.imageId : await dockerImageConfigDigest(record.tag, directory);
    if (configDigest !== record.configDigest || loaded.arch !== record.arch)
      throw new Error("Loaded publication configuration differs");
    const tag = `${registry}/${record.role}:candidate-${commit}-${record.arch}`;
    await imageCommand(["docker", "tag", record.tag, tag]);
    await imageCommand(["docker", "push", tag]);
    const [image] = JSON.parse(await imageCommand(["docker", "image", "inspect", tag], { capture: true }));
    const digest = (image.RepoDigests as string[]).find((reference) =>
      reference.startsWith(`${registry}/${record.role}@sha256:`),
    );
    if (!digest) throw new Error("Published image digest is missing");
    published.push({
      role: record.role,
      arch: record.arch,
      image: digest,
      sourceImageId: record.imageId,
      loadedImageId: loaded.imageId,
      configDigest,
    });
  }
  const indexes: { role: string; image: string; architectures: string[] }[] = [];
  for (const role of imageRoles) {
    const references = published.filter((record) => record.role === role).map((record) => record.image);
    const tag = `${registry}/${role}:candidate-${commit}`;
    await imageCommand(["docker", "buildx", "imagetools", "create", "--tag", tag, ...references]);
    const manifest = JSON.parse(
      await imageCommand(["docker", "buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"], {
        capture: true,
      }),
    );
    indexes.push({
      role,
      image: `${registry}/${role}@${manifest.digest}`,
      architectures: manifest.manifests.map(
        (entry: { platform: { architecture: string } }) => entry.platform.architecture,
      ),
    });
  }
  const result = { commit, channel: "candidate", published, indexes };
  await Bun.write(join(directory, "published.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  const [directory, commit, registry] = process.argv.slice(2);
  if (!directory || !commit || !registry)
    throw new Error("Usage: publish-candidate-images.ts <directory> <commit> <ghcr.io/owner/repo>");
  await publishCandidateImages(resolve(directory), commit, registry);
}
