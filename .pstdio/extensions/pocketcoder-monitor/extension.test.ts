import { describe, expect, test } from "bun:test";
import extension from "./extension";

describe("PocketCoder monitor extension", () => {
	test("registers the monitor route and project navigation entry", () => {
		expect(extension.routes?.monitor).toMatchObject({
			path: "pocketcoder-monitor",
			label: "PocketCoder Monitor",
			webview: {
				entry: { path: "./src/view.ts" },
				capabilities: ["commands.execute"],
			},
		});
		expect(extension.treeItems?.monitor).toMatchObject({
			target: "workbench.left.tree",
			action: { kind: "route", route: "pocketcoder-monitor" },
			when: { mode: "project" },
		});
	});

	test("returns a snapshot from the default project repository", async () => {
		const command = extension.commands?.snapshot;
		const result = await command?.run({
			params: {},
			repos: {
				getDefault: async () => ({ projectId: "project-1", repoId: "repo-1", path: "/repo" }),
			},
			process: {
				run: async ({ command: argv }: { command: string[] }) => ({
					exitCode: 0,
					stderr: "",
					stdout: argv.includes("workspaces") ? "[]" : "[]",
				}),
			},
		} as never);

		expect(result).toMatchObject({
			workspaces: [],
			templates: [],
			errors: [],
		});
	});
});
