import { defineExtension } from "@pstdio/sdk/extensions";
import { createMachineHarness } from "./src/agent";
import { catalogView } from "./src/catalog-view";
import { commands } from "./src/commands";
import { relaunchMachine, resumeMachine } from "./src/machine-lifecycle";
import { machineLifecycleActions } from "./src/machine-lifecycle-actions";
import { watchMachine } from "./src/machine-watch";
import { createMachineProvider } from "./src/machines";
import { createManagedHarness } from "./src/managed-agent";
import { openManagedSessions } from "./src/managed-sessions";
import { instancesView, machinesView, templatesView } from "./src/native-tables";
import { instanceKind, machineKind, templateKind } from "./src/resources";
import { selectionCommands } from "./src/selection-commands";
import { tableCommands } from "./src/table-commands";
import { deleteTemplateRow, openCatalog, viewTemplateRow } from "./src/template-commands";
import { templateFileView, templatePage } from "./src/template-view";
import { catalogPage, instancePage, instancesPage, navigation } from "./src/workbench";

export default defineExtension({
  commands: [
    ...commands,
    ...tableCommands,
    ...Object.values(selectionCommands),
    deleteTemplateRow,
    viewTemplateRow,
    openCatalog,
    relaunchMachine,
    resumeMachine,
    ...Object.values(machineLifecycleActions),
    watchMachine,
    openManagedSessions,
  ],
  workspaceTypes: [createMachineProvider()],
  harnesses: [createMachineHarness(), createManagedHarness()],
  resourceKinds: [instanceKind, machineKind, templateKind],
  views: [instancesView, templatesView, machinesView, catalogView, templateFileView],
  pages: [instancesPage, instancePage, catalogPage, templatePage],
  navigationItems: [navigation],
});
