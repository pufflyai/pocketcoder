import { readdir } from "node:fs/promises";
import { join } from "node:path";

interface PackageManifest {
	name?: string;
	private?: boolean;
}

const workspaceRoots = ["apps", "packages"];
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
		console.log(`Checking npm publication for ${manifest.name ?? packageDir}`);
		const child = Bun.spawn(["npm", "publish", "--dry-run", "--ignore-scripts", "--json"], {
			cwd: packageDir,
			stdout: "inherit",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		if (stderr) process.stderr.write(stderr);
		if (exitCode !== 0 || stderr.includes("npm warn publish")) failed = true;
	}
}

if (publishableCount === 0) {
	console.log("No publishable npm packages; skipping package-content checks.");
}

if (failed) process.exit(1);
