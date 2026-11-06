import { defineView } from "@pstdio/sdk/extensions";
import { refresh } from "./commands";
import { launchInstance } from "./instance-commands";
import { changed } from "./resources";
import { catalogFiles, listCatalog, templateDirectory } from "./template-catalog";
import { deleteTemplate, saveTemplate } from "./template-commands";

export const templatesView = defineView({
  id: "templates",
  title: "Agent templates",
  icon: "package",
  body: {
    kind: "dataTable",
    refreshEvents: [changed],
    emptyTitle: "Add an agent template",
    emptyDescription: `Use Save template, or write a JSON or YAML template in ${templateDirectory}, then Refresh.`,
    toolbarActions: [
      {
        id: "save",
        label: "Save template",
        icon: "file-plus",
        command: saveTemplate.ref,
        input: saveTemplate.params,
        submitLabel: "Save template",
      },
      {
        id: "launch",
        label: "Launch instance",
        icon: "plus",
        presentation: "secondary",
        command: launchInstance.ref,
        input: launchInstance.params,
        submitLabel: "Launch instance",
      },
      { id: "refresh", label: "Refresh", icon: "refresh-cw", presentation: "secondary", command: refresh.ref },
    ],
    rowActions: [
      { id: "delete", label: "Remove from catalog", icon: "trash-2", destructive: true, command: deleteTemplate.ref },
    ],
    columns: [
      { id: "name", label: "Template" },
      { id: "version", label: "Version" },
      { id: "description", label: "Description" },
      { id: "path", label: "File" },
      { id: "error", label: "Issue" },
    ],
    async query(ctx) {
      return {
        rows: (await listCatalog(catalogFiles(ctx))).map(({ path, template, error }) => ({
          id: path,
          values: {
            name: template?.name ?? path.split("/").pop() ?? path,
            version: template?.version ?? "",
            description: template?.description ?? "",
            path,
            error,
          },
        })),
      };
    },
  },
});
