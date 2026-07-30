import { resolve } from "node:path";
import { runLicenseCheck } from "@lizenz/checker";

export const ALLOWED_LICENSES = [
	"0BSD",
	"Apache-2.0",
	"BlueOak-1.0.0",
	"BSD",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"CC-BY-3.0",
	"CC0-1.0",
	"ISC",
	"MIT",
	"Python-2.0",
] as const;

type CheckLicenseOptions = {
	start: string;
	excludePackages?: string;
	clarificationsFile?: string;
};

export async function checkLicenses({
	start,
	excludePackages,
	clarificationsFile,
}: CheckLicenseOptions) {
	const packages = await runLicenseCheck({
		start,
		onlyAllow: ALLOWED_LICENSES.join(";"),
		excludePackages,
		clarificationsFile,
		clarificationsMatchAll: clarificationsFile ? true : undefined,
	});

	const counts = new Map<string, number>();
	for (const dependency of Object.values(packages)) {
		const license = Array.isArray(dependency.licenses)
			? dependency.licenses.join(" AND ")
			: (dependency.licenses ?? "UNKNOWN");
		counts.set(license, (counts.get(license) ?? 0) + 1);
	}

	console.log(`Checked ${Object.keys(packages).length} installed packages:`);
	for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
		console.log(`- ${license}: ${count}`);
	}

	return packages;
}

if (import.meta.main) {
	const repositoryRoot = resolve(import.meta.dir, "..");
	await checkLicenses({
		start: repositoryRoot,
		excludePackages: "pocketcoder@0.0.0",
		clarificationsFile: resolve(repositoryRoot, "license-clarifications.json"),
	});
}
