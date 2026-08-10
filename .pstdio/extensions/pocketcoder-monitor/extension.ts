import { defineExtension, packageAsset } from "@pstdio/sdk/extensions";
import { loadPocketcoderSnapshot, type ProcessRunner } from "./src/snapshot";

interface SnapshotCommandContext {
  repos: {
    getDefault(): Promise<{ path?: string } | undefined>;
  };
  process: ProcessRunner;
}

// Prompt Studio persists this id in the dashboard's navigation history, and replaying an
// entry whose mode is no longer registered throws `Workbench mode not registered` instead
// of degrading (PS-225). Until that lands, the monitor stays a mode under its original id
// so the persisted state keeps resolving; the panel below is what the mode opens.
export const MODE_ID = "pocketcoder.pocketcoder-monitor.monitor";

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

  modes: {
    monitor: {
      id: MODE_ID,
      label: "PocketCoder",
      icon: "activity",
      layout: {
        panels: ["main"],
        open: [{ region: "main", panel: "monitor" }],
      },
    },
  },

  panels: {
    monitor: {
      title: "PocketCoder Monitor",
      region: "main",
      closable: false,
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
      action: {
        kind: "command",
        command: "workbench.action.switchMode",
        params: { modeId: MODE_ID },
      },
      // No `when` clause: gating on `mode: "project"` hides the entry as soon as
      // switching to this mode leaves the project mode.
    },
  },
});
