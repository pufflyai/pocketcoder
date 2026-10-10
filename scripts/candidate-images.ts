import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { imageArchiveConfigDigest } from "./image-config";
import { imageArchitectures, imageRoles } from "./image-policy";
import { scanGlibcImage } from "./image-rootfs";
import { scanImageArchive } from "./image-scan";
import { imageCommand, imageFileHash, imageIdentity } from "./image-tools";

export type CandidateImageRecord = {
  role: (typeof imageRoles)[number];
  arch: (typeof imageArchitectures)[number];
  commit: string;
  channel: "candidate";
  result: "scanned" | "passed";
  tag: string;
  imageId: string;
  configDigest: string;
  bytes: number;
  labels: Record<string, string>;
  sourceBun: string;
  database?: Record<string, unknown>;
  cli?: { command: "pocketcoder"; format: "bun-script"; bytes: number; runtime: string };
  archive: { file: string; sha256: string };
  scanner: { Version: string; VulnerabilityDB: { UpdatedAt: string; Version: number } };
  evidence: { file: string; sha256: string }[];
  smoke?: { file: string; sha256: string };
};

async function assertCandidateCheckout(commit: string, arch: string) {
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    (await imageCommand(["git", "rev-parse", "HEAD"], { capture: true })) !== commit
  )
    throw new Error("Build the checked-out full source commit");
  if (await imageCommand(["git", "status", "--porcelain"], { capture: true }))
    throw new Error("Candidate builds require a clean source checkout, including untracked files");
  if (!(imageArchitectures as readonly string[]).includes(arch)) throw new Error("Unsupported image architecture");
}

async function roleMetadata(role: CandidateImageRecord["role"], tag: string) {
  const metadata: Pick<CandidateImageRecord, "database" | "cli"> = {};
  if (["server", "manager"].includes(role)) {
    const seed = role === "server" ? "packages/db/assets/core-seed.json" : "packages/manager/assets/manager-seed.json";
    metadata.database = await Bun.file(seed).json();
  }
  if (role === "server")
    metadata.cli = JSON.parse(
      await imageCommand(
        [
          "docker",
          "run",
          "--rm",
          "--entrypoint",
          "bun",
          tag,
          "-e",
          "console.log(JSON.stringify({command:'pocketcoder',format:'bun-script',bytes:Bun.file('/opt/pocketcoder/cli/index.js').size,runtime:Bun.version}))",
        ],
        { capture: true },
      ),
    );
  return metadata;
}

export async function buildCandidateImages(directory: string, commit: string, arch: string) {
  await assertCandidateCheckout(commit, arch);
  await mkdir(directory, { recursive: true });
  await imageCommand([
    process.execPath,
    "build",
    "packages/supervisor/src/index.ts",
    "--target",
    "bun",
    "--outdir",
    "deploy/image/dist",
  ]);
  const workspace = `pocketcoder-candidate-workspace:${commit}-${arch}`;
  for (const role of imageRoles) {
    const tag = `pocketcoder-candidate-${role}:${commit}-${arch}`;
    const context = ["workspace", "desktop", "browser"].includes(role) ? "deploy/image" : ".";
    const recipes = { workspace: "deploy/image/Dockerfile", egress: "packages/egress/Dockerfile" };
    const file = role in recipes ? recipes[role as keyof typeof recipes] : `deploy/image/${role}.Dockerfile`;
    await imageCommand([
      "docker",
      "build",
      "--platform",
      `linux/${arch}`,
      "--file",
      file,
      "--tag",
      tag,
      "--label",
      `org.opencontainers.image.revision=${commit}`,
      "--label",
      "dev.pocketcoder.channel=candidate",
      ...(["desktop", "browser"].includes(role) ? ["--build-arg", `BASE_IMAGE=${workspace}`] : []),
      context,
    ]);
    const identity = await imageIdentity(tag);
    if (identity.arch !== arch) throw new Error(`Built architecture differs: ${role}`);
    if (role === "desktop" && identity.bytes >= 1_500_000_000) throw new Error("Desktop image exceeds 1.5 GB");
    const name = `${role}-${arch}`;
    const archive = `${name}.tar`;
    await imageCommand(["docker", "save", "--output", join(directory, archive), tag]);
    const scan = await scanImageArchive(directory, join(directory, archive), name);
    if (["workspace", "desktop", "browser"].includes(role))
      scan.evidence.push(...(await scanGlibcImage(directory, tag, name)));
    const record: CandidateImageRecord = {
      role,
      arch: arch as CandidateImageRecord["arch"],
      commit,
      channel: "candidate",
      result: "scanned",
      tag,
      imageId: identity.imageId,
      configDigest: await imageArchiveConfigDigest(join(directory, archive)),
      bytes: identity.bytes,
      labels: identity.labels,
      sourceBun: Bun.version,
      ...(await roleMetadata(role, tag)),
      archive: { file: archive, sha256: await imageFileHash(join(directory, archive)) },
      ...scan,
    };
    await Bun.write(join(directory, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
}

if (import.meta.main) {
  const [directory, commit, arch] = process.argv.slice(2);
  if (!directory || !commit || !arch) throw new Error("Usage: candidate-images.ts <directory> <commit> <amd64|arm64>");
  await buildCandidateImages(resolve(directory), commit, arch);
}
