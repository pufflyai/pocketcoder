import { defineExtension } from "@pstdio/sdk/extensions";
import { createMachineHarness } from "./src/agent";
import { commands } from "./src/commands";
import { relaunchMachine, resumeMachine } from "./src/machine-lifecycle";
import { machineLifecycleActions } from "./src/machine-lifecycle-actions";
import { watchMachine } from "./src/machine-watch";
import { createMachineProvider } from "./src/machines";
import { instancesView, machinesView, templatesView } from "./src/native-tables";
import { instanceKind, machineKind } from "./src/resources";
import { tableCommands } from "./src/table-commands";
import { instancePage, instancesPage, navigation } from "./src/workbench";

export default defineExtension({
  commands: [
    ...commands,
    ...tableCommands,
    relaunchMachine,
    resumeMachine,
    ...Object.values(machineLifecycleActions),
    watchMachine,
  ],
  workspaceTypes: [createMachineProvider()],
  harnesses: [createMachineHarness()],
  resourceKinds: [instanceKind, machineKind],
  views: [instancesView, templatesView, machinesView],
  pages: [instancesPage, instancePage],
  navigationItems: [navigation],
});
