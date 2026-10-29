import { join } from "node:path";
import { assertImageScan } from "./image-policy";
import { imageCommand, imageFileHash } from "./image-tools";

async function scan(directory: string, target: string[], name: string) {
  // Scanner policy cannot inherit exemptions from a developer's environment or config.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TRIVY_CACHE_DIR: process.env.TRIVY_CACHE_DIR };
  const policy = [
    "trivy",
    ...target,
    "--config",
    "/dev/null",
    "--ignorefile",
    "/dev/null",
    "--ignore-unfixed=false",
    "--ignore-status",
    "",
    "--scanners",
    "vuln",
    "--pkg-types",
    "os,library",
    "--skip-version-check",
  ];
  const scan = `${name}.scan.json`;
  await imageCommand(
    [...policy, "--severity", "HIGH,CRITICAL", "--format", "json", "--output", join(directory, scan)],
    { env },
  );
  const scanner = JSON.parse(await imageCommand(["trivy", "--version", "--format", "json"], { env, capture: true }));
  if (scanner.Version !== "0.74.0" || !scanner.VulnerabilityDB?.UpdatedAt)
    throw new Error("Pinned scanner and database metadata are required");
  const scannerPath = `${name}.scanner.json`;
  await Bun.write(join(directory, scannerPath), `${JSON.stringify(scanner, null, 2)}\n`);
  const sbom = `${name}.sbom.cdx.json`;
  await imageCommand([...policy, "--format", "cyclonedx", "--output", join(directory, sbom)], { env });
  assertImageScan(await Bun.file(join(directory, scan)).json());
  return {
    scanner,
    evidence: await Promise.all(
      [scan, scannerPath, sbom].map(async (file) => ({ file, sha256: await imageFileHash(join(directory, file)) })),
    ),
  };
}

export const scanImageArchive = (directory: string, archive: string, name: string) =>
  scan(directory, ["image", "--input", archive], name);

export const scanRootfs = (directory: string, root: string, name: string) => scan(directory, ["rootfs", root], name);
