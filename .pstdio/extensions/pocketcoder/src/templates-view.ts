import { defineView } from "@pstdio/sdk/extensions";
import { refresh } from "./commands";
import { launchInstance } from "./instance-commands";
import { changed } from "./resources";
import { catalogFiles, listCatalog, templateDirectory } from "./template-catalog";

export const templatesView = defineView({
  id: "templates",
  title: "Agent templates",
  icon: "package",
  body: {
    kind: "dataTable",
    refreshEvents: [changed],
    emptyTitle: "Add an agent template",
    emptyDescription: `Ask your agent to write a JSON or YAML template in ${templateDirectory}, then Refresh.`,
    toolbarActions: [
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
