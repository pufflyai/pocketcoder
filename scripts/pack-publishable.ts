import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertNoLocalInstallDependencies,
  assertWorkspaceInstallDependencies,
} from "./check-publishable-manifest";
import { checkSdkPackage } from "./check-sdk-package";

interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const workspaceRoots = ["packages"];
const packages: { directory: string; manifest: PackageManifest }[] = [];
const packageDirs = new Map<string, string>();
const manifests = new Map<string, PackageManifest>();
const manifestsOnly = process.argv.includes("--manifests-only");
let publishableCount = 0;
let failed = false;

for (const root of workspaceRoots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packageDir = join(root, entry.name);
    const packageJson = Bun.file(join(packageDir, "package.json"));
    if (!(await packageJson.exists())) continue;

    const manifest = (await packageJson.json()) as PackageManifest;
    packages.push({ directory: packageDir, manifest });
    manifests.set(manifest.name, manifest);
  }
}

// Load every manifest first so dependency validation does not depend on directory order.
for (const { directory: packageDir, manifest } of packages) {
  if (manifest.private === true) continue;

  const { name } = manifest;
  packageDirs.set(name, packageDir);
  publishableCount += 1;
  console.log(`Checking publishable manifest for ${name}`);
  try {
    assertNoLocalInstallDependencies(manifest);
    assertWorkspaceInstallDependencies(manifest, manifests);
  } catch (error) {
    console.error(error);
    failed = true;
  }
  if (manifestsOnly) continue;

  console.log(`Checking npm package contents for ${name}`);
  const child = Bun.spawn(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: packageDir,
    stdout: "inherit",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  if (stderr) process.stderr.write(stderr);
  if (exitCode !== 0) failed = true;
}

const sdkDir = packageDirs.get("@pstdio/pocketcoder-sdk");
if (sdkDir && !manifestsOnly) {
  try {
    await checkSdkPackage(sdkDir, packageDirs.get("@pstdio/pocketcoder-remote"));
  } catch (error) {
    console.error(error);
    failed = true;
  }
}

if (publishableCount === 0) {
  console.log("No publishable npm packages; skipping package-content checks.");
} else if (manifestsOnly && !failed) {
  console.log("Publishable package manifests are valid.");
}

if (failed) process.exit(1);
