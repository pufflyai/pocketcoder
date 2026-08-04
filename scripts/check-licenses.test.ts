import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLicenses } from "./check-licenses";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("checkLicenses", () => {
	test("ignores private workspace packages", async () => {
		const root = await mkdtemp(join(tmpdir(), "pocketcoder-licenses-"));
		temporaryDirectories.push(root);

		const dependencyDirectory = join(root, "node_modules", "private-package");
		await mkdir(dependencyDirectory, { recursive: true });
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "license-fixture",
				version: "1.0.0",
				license: "MIT",
				dependencies: {
					"private-package": "1.0.0",
				},
			}),
		);
		await writeFile(
			join(dependencyDirectory, "package.json"),
			JSON.stringify({
				name: "private-package",
				version: "1.0.0",
				private: true,
				license: "MIT",
			}),
		);

		await expect(
			checkLicenses({
				start: root,
				excludePackages: "license-fixture@1.0.0",
			}),
		).resolves.toEqual({});
	});

	test("rejects an installed dependency with a disallowed license", async () => {
		const root = await mkdtemp(join(tmpdir(), "pocketcoder-licenses-"));
		temporaryDirectories.push(root);

		const dependencyDirectory = join(root, "node_modules", "copyleft-package");
		await mkdir(dependencyDirectory, { recursive: true });
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				name: "license-fixture",
				version: "1.0.0",
				license: "MIT",
				dependencies: {
					"copyleft-package": "1.0.0",
				},
			}),
		);
		await writeFile(
			join(dependencyDirectory, "package.json"),
			JSON.stringify({
				name: "copyleft-package",
				version: "1.0.0",
				license: "GPL-3.0-only",
			}),
		);

		await expect(
			checkLicenses({
				start: root,
				excludePackages: "license-fixture@1.0.0",
			}),
		).rejects.toThrow('Package "copyleft-package@1.0.0" is licensed under "GPL-3.0-only"');
	});
});
