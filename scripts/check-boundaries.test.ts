import { expect, test } from "bun:test";
import { boundaryViolations, projectBoundaryViolations } from "./check-boundaries";

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
				dependencies: ["@example/db"],
			},
			{
				path: "packages/db/package.json",
				name: "@example/db",
				tags: ["type:adapter"],
				dependencies: [],
			},
			{
				path: "packages/untagged/package.json",
				name: "@example/untagged",
				tags: [],
				dependencies: [],
			},
		]),
	).toEqual([
		"packages/core/package.json: type:application cannot depend on type:adapter (@example/db)",
		"packages/untagged/package.json: project requires an Nx type tag",
	]);
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
