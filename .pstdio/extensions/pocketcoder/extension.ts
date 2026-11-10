import { defineExtension } from "@pstdio/sdk/extensions";
import { createMachineHarness } from "./src/agent";
import { commands } from "./src/commands";
import { relaunchMachine, resumeMachine } from "./src/machine-lifecycle";
import { relaunchDialog, resumeDialog } from "./src/machine-lifecycle-ui";
import { createMachineProvider } from "./src/machines";
import { instancesView, machinesView, templatesView } from "./src/native-tables";
import { instanceKind, machineKind } from "./src/resources";
import { tableCommands } from "./src/table-commands";
import { instancePage, instancesPage, navigation } from "./src/workbench";

export default defineExtension({
  commands: [...commands, ...tableCommands, relaunchMachine, resumeMachine, relaunchDialog.open, resumeDialog.open],
  workspaceTypes: [createMachineProvider()],
  harnesses: [createMachineHarness()],
  resourceKinds: [instanceKind, machineKind],
  views: [instancesView, templatesView, machinesView, relaunchDialog.view, resumeDialog.view],
  pages: [instancesPage, instancePage, relaunchDialog.page, resumeDialog.page],
  navigationItems: [navigation],
});
