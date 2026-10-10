import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { probeImageAgentApi } from "../examples/e2e/image-agentapi";
import { startDockerImageController } from "../examples/e2e/image-controller";
import { probeManagerImage } from "../examples/e2e/image-managed-accounts";
import { volumeUsageFile } from "../examples/e2e/image-volume-usage";
import { nativeController } from "../examples/native/controller";
import { controllerPorts } from "../examples/native/ports";
import type { CandidateImageRecord } from "./candidate-images";
import { imageRoles } from "./image-policy";
import { imageCommand, imageFileHash, imageIdentity } from "./image-tools";

const checkpointTests = [
  "packages/supervisor/src/checkpoints/filesystem-upload.test.ts",
  "packages/supervisor/src/checkpoints/filesystem-download.test.ts",
  "packages/supervisor/src/checkpoints/filesystem-download-native.test.ts",
  "packages/supervisor/src/checkpoints/filesystem-download-lifetime.test.ts",
  "packages/supervisor/src/checkpoints/filesystem-publication.test.ts",
  "packages/supervisor/src/checkpoints/filesystem-upload.ts",
  "packages/supervisor/src/checkpoints/filesystem-download.ts",
];

const filesystemTests = [
  "packages/db/src/database/canonical-path.test.ts",
  "packages/db/src/database/data-folder.test.ts",
  "packages/db/src/database/pglite.test.ts",
  "packages/db/src/checkpoints/destination-native.test.ts",
  "packages/db/src/checkpoints/directory-reader.test.ts",
  "packages/db/src/checkpoints/destination.test.ts",
  "packages/db/src/checkpoints/destination-privacy-linux.test.ts",
  "packages/db/src/checkpoints/archive-publication.test.ts",
];

async function buildNativeExecutable() {
  await imageCommand([process.execPath, "run", "build:native"]);
  const bytes = Bun.file("out/native/pocketcoder").size;
  if (bytes > 90_000_000) throw new Error(`Native executable exceeds 90 MB: ${bytes} bytes`);
  return { bytes, sourceBun: Bun.version };
}

async function volumeUsageCommand(fixture: string, image: string) {
  const volumeUsage = join(fixture, "volume-usage.js");
  await imageCommand([process.execPath, "build", volumeUsageFile, "--target", "bun", "--outfile", volumeUsage]);
  return [
    "docker",
    "run",
    "--rm",
    "--entrypoint",
    "bun",
    "--mount",
    `type=bind,src=${volumeUsage},dst=/tests/volume-usage.js,readonly`,
    image,
    "/tests/volume-usage.js",
  ];
}

export async function smokeCandidateImages(directory: string, commit: string, arch: string) {
  const nativeArch = process.arch === "x64" ? "amd64" : process.arch;
  if (arch !== nativeArch) throw new Error("Run image role smoke on its native architecture");
  const records: CandidateImageRecord[] = [];
  const images: Record<string, string> = {};
  for (const role of imageRoles) {
    const record = (await Bun.file(join(directory, `${role}-${arch}.json`)).json()) as CandidateImageRecord;
    if (record.commit !== commit || record.arch !== arch || record.result !== "scanned")
      throw new Error("Smoke requires scanned images from the same commit");
    if ((await imageFileHash(join(directory, record.archive.file))) !== record.archive.sha256)
      throw new Error("Image archive checksum differs");
    const identity = await imageIdentity(record.tag);
    if (identity.imageId !== record.imageId) throw new Error("Loaded smoke image differs from scanned archive");
    records.push(record);
    images[role] = record.tag;
  }
  const fixture = await mkdtemp(join(tmpdir(), "pc-candidate-image-smoke-"));
  const outputs: Record<string, unknown> = {};
  const logs: { file: string; sha256: string }[] = [];
  async function run(name: string, args: string[], environment: Record<string, string> = {}) {
    const child = Bun.spawn(args, { env: { ...process.env, ...environment }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const file = `${arch}.${name}.log`;
    await Bun.write(join(directory, file), `${stdout}\n${stderr}`);
    logs.push({ file, sha256: await imageFileHash(join(directory, file)) });
    if (code) throw new Error(`Candidate image smoke failed: ${name}; see ${file}`);
  }
  try {
    const bundled = join(fixture, "filesystem");
    await mkdir(bundled);
    await imageCommand([process.execPath, "build", ...filesystemTests, "--target", "bun", "--outdir", bundled]);
    await run("filesystem", [
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      "--mount",
      `type=bind,src=${bundled},dst=/tests,readonly`,
      "--workdir",
      "/tests",
      images.server as string,
      "test",
    ]);
    await run("volume-usage", await volumeUsageCommand(fixture, images.server as string));
    const checkpoints = join(fixture, "checkpoints");
    await mkdir(checkpoints);
    await imageCommand([process.execPath, "build", ...checkpointTests, "--target", "bun", "--outdir", checkpoints]);
    await run("workspace-checkpoints", [
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      "--mount",
      `type=bind,src=${checkpoints},dst=/tests,readonly`,
      "--workdir",
      "/tests",
      images.workspace as string,
      "test",
    ]);
    const lease = join(fixture, "lease");
    await mkdir(lease);
    await imageCommand([
      process.execPath,
      "build",
      "packages/supervisor/src/credentials/lease-directory.test.ts",
      "--target",
      "bun",
      "--outdir",
      lease,
    ]);
    await run("leases", [
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "bun",
      "--mount",
      `type=bind,src=${lease},dst=/tests,readonly`,
      "--workdir",
      "/tests",
      images.workspace as string,
      "test",
    ]);
    const dockerDir = join(fixture, "docker");
    await mkdir(dockerDir);
    const ports = controllerPorts();
    ports.release();
    const docker = await startDockerImageController({
      image: images.server as string,
      directory: dockerDir,
      operatorPort: ports.operator,
      agentPort: ports.agent,
    });
    try {
      const owner = JSON.parse(
        await imageCommand(
          [
            ...docker.cli,
            "superuser",
            "create",
            "--automation",
            "--expires",
            new Date(Date.now() + 600_000).toISOString(),
            "--request-id",
            randomUUID(),
            "--json",
          ],
          { capture: true },
        ),
      );
      outputs.docker = {
        ...(await probeImageAgentApi(
          docker.baseUrl,
          owner.token,
          `${images.workspace}@${(records.find((r) => r.role === "workspace") as CandidateImageRecord).imageId}`,
        )),
        startup: docker.measurement,
      };
    } finally {
      await docker.close();
    }
    outputs.nativeExecutable = await buildNativeExecutable();
    const nativeDir = join(fixture, "native");
    await mkdir(nativeDir);
    const native = await nativeController(resolve("out/native/pocketcoder"), nativeDir);
    try {
      await native.start();
      const owner = JSON.parse(
        await native.run([
          "superuser",
          "create",
          "--automation",
          "--expires",
          new Date(Date.now() + 600_000).toISOString(),
          "--request-id",
          randomUUID(),
          "--json",
        ]),
      );
      outputs.native = await probeImageAgentApi(
        native.baseUrl,
        owner.token,
        `${images.workspace}@${(records.find((r) => r.role === "workspace") as CandidateImageRecord).imageId}`,
      );
      await native.stop();
      outputs.nativeStartup = native.measurements;
    } finally {
      await native.stop();
    }
    const env = Object.fromEntries(
      records.map((r) => [`POCKETCODER_SMOKE_${r.role.toUpperCase()}_IMAGE`, `${r.tag}@${r.imageId}`]),
    );
    await run("desktop", [process.execPath, "--no-env-file", "examples/e2e/desktop.ts"], env);
    await run("browser", [process.execPath, "--no-env-file", "examples/e2e/browser.ts"], env);
    await run(
      "docker-egress",
      [
        process.execPath,
        "test",
        "packages/egress/src/proxy/docker-conformance.test.ts",
        "packages/drivers/src/docker/docker-egress-conformance.test.ts",
      ],
      { POCKETCODER_EGRESS_CONFORMANCE_IMAGE: images.egress as string },
    );
    outputs.kubernetes = await probeManagerImage(
      images as {
        manager: string;
        server: string;
        workspace: string;
        egress: string;
        desktop: string;
        browser: string;
      },
      Object.fromEntries(records.map((r) => [r.role, r.configDigest])),
    );
    const file = `${arch}.smoke.json`;
    await Bun.write(
      join(directory, file),
      `${JSON.stringify({ result: "passed", commit, arch, images: records.map((r) => ({ role: r.role, imageId: r.imageId, configDigest: r.configDigest, archive: r.archive })), outputs, logs }, null, 2)}\n`,
    );
    for (const record of records) {
      record.result = "passed";
      record.smoke = { file, sha256: await imageFileHash(join(directory, file)) };
      await Bun.write(join(directory, `${record.role}-${arch}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [directory, commit, arch] = process.argv.slice(2);
  if (!directory || !commit || !arch) throw new Error("Usage: image-smoke.ts <directory> <commit> <amd64|arm64>");
  await smokeCandidateImages(resolve(directory), commit, arch);
}
