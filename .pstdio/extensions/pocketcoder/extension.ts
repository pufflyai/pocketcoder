import { defineExtension } from "@pstdio/sdk/extensions";
import { createMachineHarness } from "./src/agent";
import { commands } from "./src/commands";
import { createMachineProvider } from "./src/machines";
import { instanceKind } from "./src/resources";
import { templatesView } from "./src/templates-view";
import { instancePage, instancesPage, instancesView, machinesView, navigation } from "./src/workbench";

export default defineExtension({
  commands,
  workspaceTypes: [createMachineProvider()],
  harnesses: [createMachineHarness()],
  resourceKinds: [instanceKind],
  views: [templatesView, instancesView, machinesView],
  pages: [instancesPage, instancePage],
  navigationItems: [navigation],
});
