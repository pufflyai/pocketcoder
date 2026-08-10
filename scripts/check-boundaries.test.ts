import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	boundaryViolations,
	projectBoundaryViolations,
	publishedDependencyViolations,
} from "./check-boundaries";

test("runs without external file discovery tools", async () => {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "check-boundaries.ts")], {
		cwd: join(import.meta.dir, ".."),
		env: { ...process.env, PATH: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);

	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	expect(stdout).toContain("Package boundaries are valid.");
});

test("reports deep source imports and production testkit dependencies", () => {
	expect(
		boundaryViolations([
			{
				path: "packages/cli/src/server.ts",
				text: 'import "../../../apps/pocketcoder-server/src/lifecycle";',
			},
			{
				path: "apps/server/src/lifecycle.ts",
				text: 'import { MemoryStore } from "@pstdio/pocketcoder-testkit";',
			},
		]),
	).toEqual([
		"packages/cli/src/server.ts: deep source import bypasses a package export",
		"apps/server/src/lifecycle.ts: production code imports testkit",
	]);
});

test("requires Nx tags and rejects inward layers depending on adapters", () => {
	expect(
		projectBoundaryViolations([
			{
				path: "packages/core/package.json",
				name: "@example/core",
				tags: ["type:application"],
				private: true,
				dependencies: ["@example/db"],
			},
			{
				path: "packages/db/package.json",
				name: "@example/db",
				tags: ["type:adapter"],
				private: true,
				dependencies: [],
			},
			{
				path: "packages/untagged/package.json",
				name: "@example/untagged",
				tags: [],
				private: true,
				dependencies: [],
			},
		]),
	).toEqual([
		"packages/core/package.json: type:application cannot depend on type:adapter (@example/db)",
		"packages/untagged/package.json: project requires an Nx type tag",
	]);
});

test("rejects published packages that depend on unpublished ones at runtime", () => {
	expect(
		publishedDependencyViolations([
			{
				path: "packages/remote/package.json",
				name: "@example/remote",
				tags: ["type:app"],
				private: false,
				dependencies: ["@example/client", "zod"],
			},
			{
				path: "packages/sdk/package.json",
				name: "@example/client",
				tags: ["type:library"],
				private: true,
				dependencies: [],
			},
		]),
	).toEqual([
		"packages/remote/package.json: published package cannot depend on unpublished @example/client",
	]);
});

test("allows published packages to depend on published ones and bundled dev dependencies", () => {
	expect(
		publishedDependencyViolations([
			{
				path: "packages/remote/package.json",
				name: "@example/remote",
				tags: ["type:app"],
				private: false,
				dependencies: ["@example/contracts"],
			},
			{
				path: "packages/contracts/package.json",
				name: "@example/contracts",
				tags: ["type:library"],
				private: false,
				dependencies: [],
			},
			{
				path: "packages/internal/package.json",
				name: "@example/internal",
				tags: ["type:library"],
				private: true,
				dependencies: ["@example/other-private"],
			},
		]),
	).toEqual([]);
});

test("allows package exports and test-only fixtures", () => {
	expect(
		boundaryViolations([
			{
				path: "packages/cli/src/server.ts",
				text: 'import { start } from "@pstdio/pocketcoder-server/lifecycle";',
			},
			{
				path: "apps/server/src/app.test.ts",
				text: 'import { FakeDriver } from "@pstdio/pocketcoder-testkit";',
			},
		]),
	).toEqual([]);
});
