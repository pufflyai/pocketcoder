import { expect, test } from "bun:test";
import { boundaryViolations } from "./check-boundaries";

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
