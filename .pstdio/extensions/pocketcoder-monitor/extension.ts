import { defineExtension, packageAsset } from "@pstdio/sdk/extensions";
import { loadPocketcoderSnapshot, type ProcessRunner } from "./src/snapshot";

interface SnapshotCommandContext {
	repos: {
		getDefault(): Promise<{ path?: string } | undefined>;
	};
	process: ProcessRunner;
}

export default defineExtension({
	commands: {
		snapshot: {
			title: "Load PocketCoder monitor snapshot",
			async run(ctx: SnapshotCommandContext) {
				const repo = await ctx.repos.getDefault();
				if (!repo?.path)
					throw new Error("PocketCoder monitor requires a default project repository.");
				return loadPocketcoderSnapshot({
					process: ctx.process,
					repoPath: repo.path,
				});
			},
		},
	},

	routes: {
		monitor: {
			path: "pocketcoder-monitor",
			label: "PocketCoder Monitor",
			webview: {
				entry: packageAsset("./src/view.ts", import.meta.url),
				capabilities: ["commands.execute"],
			},
		},
	},

	treeItems: {
		monitor: {
			target: "workbench.left.tree",
			label: "PocketCoder",
			icon: "activity",
			action: { kind: "route", route: "pocketcoder-monitor" },
			when: { mode: "project" },
		},
	},
});
