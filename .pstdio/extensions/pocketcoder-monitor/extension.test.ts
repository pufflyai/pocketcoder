import { describe, expect, test } from "bun:test";
import extension, { MODE_ID } from "./extension";

describe("PocketCoder monitor extension", () => {
	test("registers the monitor panel and project navigation entry", () => {
		expect(extension.panels?.monitor).toMatchObject({
			title: "PocketCoder Monitor",
			region: "main",
			closable: false,
			webview: {
				entry: { path: "./src/view.ts" },
				capabilities: ["commands.execute"],
			},
		});
		expect(extension.treeItems?.monitor).toMatchObject({
			target: "workbench.left.tree",
			action: {
				kind: "command",
				command: "workbench.action.switchMode",
				params: { modeId: MODE_ID },
			},
		});
	});

	// Dashboard history persists the mode id of every entry recorded inside a mode, and
	// replaying an entry whose mode is gone throws instead of degrading (PS-225). Keep this
	// id registered so the state left by earlier installs stays resolvable.
	test("keeps the persisted monitor mode id registered", () => {
		expect(extension.modes?.monitor).toMatchObject({
			id: "pocketcoder.pocketcoder-monitor.monitor",
			label: "PocketCoder",
			layout: { panels: ["main"], open: [{ region: "main", panel: "monitor" }] },
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
