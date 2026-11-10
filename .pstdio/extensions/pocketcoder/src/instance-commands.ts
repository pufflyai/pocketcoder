import { defineCommand, params } from "@pstdio/sdk/extensions";
import { instancesFor } from "./instances";
import { changed } from "./resources";
import { catalogFiles, listCatalog, selectedTemplate } from "./template-catalog";

export const catalogChoices = defineCommand({
  id: "templates.catalog",
  title: "List project agent templates",
  cli: true,
  async run(ctx) {
    return (await listCatalog(catalogFiles(ctx))).flatMap(({ template }) =>
      template
        ? [
            {
              value: template.path,
              label: `${template.name} (${template.version}) — ${template.path.split("/").pop()}`,
            },
          ]
        : [],
    );
  },
});
export const launchInstance = defineCommand({
  id: "instances.launch",
  title: "Launch PocketCoder instance",
  cli: true,
  mutating: true,
  palette: [{ group: "PocketCoder Lab", label: "Launch PocketCoder instance" }],
  params: {
    name: params.text({ label: "Instance name", required: true }),
    binary: params.text({
      label: "PocketCoder executable (optional)",
      description: "Defaults to this project's out/native/pocketcoder, then PATH.",
    }),
    template: params.select({
      label: "Agent template",
      required: true,
      options: { command: catalogChoices.ref, valueField: "value", labelField: "label" },
    }),
  },
  async run(ctx, input) {
    const template = await selectedTemplate(catalogFiles(ctx), input.template);
    const workspace = await ctx.workspaces.getDefault();
    const instance = await instancesFor(ctx.projectId).launch({
      name: input.name,
      binary: input.binary,
      projectRoot: workspace?.rootPath ?? workspace?.root_path ?? undefined,
      manifest: template.manifest,
    });
    await ctx.events.emit(changed, {});
    return instance;
  },
});
