import { defineExtension } from "@pstdio/sdk/extensions";
import { createRemoteHarness } from "./src/agent";
import { connectWorkspace, createWorkspace, deleteWorkspace, refresh } from "./src/commands";
import { connection } from "./src/connection";
import { navigation, workspacesPage, workspacesView } from "./src/workbench";
import { remoteWorkspace } from "./src/workspace";

export default defineExtension({
  settings: {
    properties: {
      templateName: {
        type: "string",
        title: "Workspace template",
        scope: "project",
        description: "Operator-approved template used for every new workspace.",
      },
      templateVersion: {
        type: "string",
        title: "Template version",
        scope: "project",
        description: "Exact published version. Existing workspaces keep their original template.",
      },
    },
  },
  connections: [connection],
  workspaceTypes: [remoteWorkspace],
  harnesses: [createRemoteHarness()],
  commands: [createWorkspace, connectWorkspace, deleteWorkspace, refresh],
  views: [workspacesView],
  pages: [workspacesPage],
  navigationItems: [navigation],
});
