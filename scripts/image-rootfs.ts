import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertImageScan } from "./image-policy";
import { scanRootfs } from "./image-scan";
import { imageCommand, imageFileHash, imageIdentity } from "./image-tools";

// Trivy selects one OS for an image. Scan the exact added Debian tree separately
// so an Alpine package result cannot hide the supervisor's GNU libc libraries.
export async function scanGlibcImage(directory: string, image: string, name: string) {
  const identity = await imageIdentity(image);
  if (identity.labels["dev.pstdio.pocketcoder.glibc.root"] !== "/opt/glibc")
    throw new Error("Workspace GNU runtime root label is missing");
  const container = `pc-image-scan-${randomUUID()}`;
  const root = join(directory, `${name}.glibc-rootfs`);
  const archive = `${name}.glibc.tar`;
  await mkdir(root);
  await imageCommand(["docker", "create", "--name", container, image], { capture: true });
  try {
    await imageCommand(["docker", "cp", `${container}:/opt/glibc/.`, root]);
    await imageCommand(["tar", "--create", "--file", join(directory, archive), "--directory", root, "."]);
    const scan = await scanRootfs(directory, root, `${name}.glibc`);
    const report = await Bun.file(join(directory, `${name}.glibc.scan.json`)).json();
    assertGlibcCoverage(report);
    return [...scan.evidence, { file: archive, sha256: await imageFileHash(join(directory, archive)) }];
  } finally {
    await imageCommand(["docker", "rm", container], { capture: true });
    await rm(root, { recursive: true, force: true });
  }
}

export function assertGlibcCoverage(report: {
  SchemaVersion: number;
  Metadata?: { OS?: { Family?: string } };
  Results?: { Target: string; Type?: string; Packages?: { Name: string; Version: string; Arch: string }[] }[];
}) {
  assertImageScan(report);
  if (report.Metadata?.OS?.Family !== "debian") throw new Error("GNU runtime scan must use Debian matching");
  const packages = report.Results?.filter((r) => r.Type === "debian").flatMap((r) => r.Packages ?? []) ?? [];
  for (const name of ["libc6", "libstdc++6", "libgcc-s1", "libgomp1", "libssl3t64", "zlib1g", "libzstd1"])
    if (!packages.some((p) => p.Name === name && p.Version && p.Arch))
      throw new Error(`GNU runtime package coverage is missing: ${name}`);
}
