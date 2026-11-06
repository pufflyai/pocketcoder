import { defineCommand, params } from "@pstdio/sdk/extensions";
import { changed } from "./resources";
import { catalogFiles, listCatalog, parseCatalogTemplate, templateDirectory } from "./template-catalog";

export const saveTemplate = defineCommand({
  id: "templates.save",
  title: "Save agent template",
  cli: true,
  mutating: true,
  params: { source: params.longText({ label: "Template JSON or YAML", required: true }) },
  async run(ctx, input) {
    let source = input.source;
    if (!source.trim().startsWith("{")) source = JSON.stringify(Bun.YAML.parse(source));
    const template = parseCatalogTemplate("template.json", source);
    const path = `${templateDirectory}/${encodeURIComponent(template.name)}-${encodeURIComponent(template.version)}.json`;
    await catalogFiles(ctx).writeText(path, JSON.stringify(template.manifest, null, 2));
    await ctx.events.emit(changed, {});
    return { path, name: template.name, version: template.version };
  },
});

export const deleteTemplate = defineCommand({
  id: "templates.delete",
  title: "Remove catalog template",
  cli: true,
  mutating: true,
  params: { rowId: params.text({ label: "Template file", required: true }) },
  async run(ctx, input) {
    const files = catalogFiles(ctx);
    const listed = (await listCatalog(files)).some((entry) => entry.path === input.rowId);
    if (!listed) throw new Error("Choose a listed template.");
    await files.delete(input.rowId);
    await ctx.events.emit(changed, {});
    return { path: input.rowId };
  },
});
