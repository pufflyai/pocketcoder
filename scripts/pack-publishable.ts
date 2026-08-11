import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { checkSdkPackage } from "./check-sdk-package";

interface PackageManifest {
  name?: string;
  private?: boolean;
}

const workspaceRoots = ["packages"];
const packageDirs = new Map<string, string>();
let publishableCount = 0;
let failed = false;

for (const root of workspaceRoots) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const packageDir = join(root, entry.name);
    const packageJson = Bun.file(join(packageDir, "package.json"));
    if (!(await packageJson.exists())) continue;

    const manifest = (await packageJson.json()) as PackageManifest;
    if (manifest.private === true) continue;

    publishableCount += 1;
    if (manifest.name) packageDirs.set(manifest.name, packageDir);
    console.log(`Checking npm package contents for ${manifest.name ?? packageDir}`);
    const child = Bun.spawn(["bun", "pm", "pack", "--dry-run", "--ignore-scripts"], {
      cwd: packageDir,
      stdout: "inherit",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (stderr) process.stderr.write(stderr);
    if (exitCode !== 0) failed = true;
  }
}

const sdkDir = packageDirs.get("@pstdio/pocketcoder-sdk");
if (sdkDir) {
  try {
    await checkSdkPackage(sdkDir, packageDirs.get("@pstdio/pocketcoder-remote"));
  } catch (error) {
    console.error(error);
    failed = true;
  }
}

if (publishableCount === 0) {
  console.log("No publishable npm packages; skipping package-content checks.");
}

if (failed) process.exit(1);
