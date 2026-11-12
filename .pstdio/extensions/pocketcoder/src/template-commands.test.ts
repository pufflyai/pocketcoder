import { expect, test } from "bun:test";
import { createMemoryRepoFiles, createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { catalogPathFor, listCatalog, templateDocument } from "./template-catalog";
import { deleteTemplates, saveTemplate } from "./template-commands";

const manifest = (name: string, version = "1.0.0") => ({
  apiVersion: "pocketcoder.dev/v1",
  kind: "Template",
  metadata: { name },
  spec: { version },
});
const context = () => {
  const files = createMemoryRepoFiles();
  const ctx = makeCommandContext({
    storage: createMemoryStorage(),
    params: {},
    projectId: "test",
    overrides: { projectFiles: files },
  });
  return { files, ctx };
};

test("templates can be saved, updated and removed together without deleting unrelated project files", async () => {
  const { files, ctx } = context();
  const first = await saveTemplate.run(ctx, { source: JSON.stringify(manifest("example")) });
  const second = await saveTemplate.run(ctx, { source: JSON.stringify(manifest("other")) });
  await saveTemplate.run(ctx, {
    source: JSON.stringify({ ...manifest("example"), metadata: { name: "example", description: "Updated" } }),
  });
  expect((await listCatalog(files))[0]?.template?.description).toBe("Updated");
  await files.writeText("unrelated.json", "keep");
  await expect(deleteTemplates.run(ctx, { rowIds: ["unrelated.json"] })).rejects.toThrow("Choose listed templates");
  await deleteTemplates.run(ctx, { rowIds: [first.path, second.path] });
  expect(await listCatalog(files)).toEqual([]);
  expect(await files.readText("unrelated.json")).toBe("keep");
});

test("a template opens as its formatted manifest, found by file or by published name and version", async () => {
  const { files, ctx } = context();
  const saved = await saveTemplate.run(ctx, { source: JSON.stringify(manifest("example", "2.0.0")) });
  expect(await catalogPathFor(files, "example", "2.0.0")).toBe(saved.path);
  await expect(catalogPathFor(files, "example", "9.9.9")).rejects.toThrow("not in this project's template catalog");
  const document = await templateDocument(files, saved.path);
  expect(document.fileName).toBe("example-2.0.0.json");
  expect(JSON.parse(document.content)).toEqual(manifest("example", "2.0.0"));
  expect(document.editable).toBe(false);
});

test("a stale selected path does not prevent deleting the remaining catalog files", async () => {
  const { files, ctx } = context();
  const first = await saveTemplate.run(ctx, { source: JSON.stringify(manifest("first")) });
  const second = await saveTemplate.run(ctx, { source: JSON.stringify(manifest("second")) });
  await files.delete(first.path);
  let refreshes = 0;
  const changed = {
    ...ctx,
    events: {
      emit: async () => {
        refreshes++;
        return { delivered: 0 };
      },
    },
  };
  await expect(deleteTemplates.run(changed, { rowIds: [first.path, second.path] })).rejects.toThrow(first.path);
  expect(await listCatalog(files)).toEqual([]);
  expect(refreshes).toBe(1);
});
