import { expect, test } from "bun:test";
import { createMemoryRepoFiles, createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { listCatalog } from "./template-catalog";
import { deleteTemplate, saveTemplate } from "./template-commands";

test("templates can be saved, updated and removed without deleting unrelated project files", async () => {
  const files = createMemoryRepoFiles();
  const ctx = makeCommandContext({
    storage: createMemoryStorage(),
    params: {},
    projectId: "test",
    overrides: { projectFiles: files },
  });
  const manifest = {
    apiVersion: "pocketcoder.dev/v1",
    kind: "Template",
    metadata: { name: "example" },
    spec: { version: "1.0.0" },
  };
  const saved = await saveTemplate.run(ctx, { source: JSON.stringify(manifest) });
  expect((await listCatalog(files))[0]?.template?.name).toBe("example");
  await saveTemplate.run(ctx, {
    source: JSON.stringify({ ...manifest, metadata: { ...manifest.metadata, description: "Updated" } }),
  });
  expect((await listCatalog(files))[0]?.template?.description).toBe("Updated");
  await files.writeText("unrelated.json", "keep");
  await expect(deleteTemplate.run(ctx, { rowId: "unrelated.json" })).rejects.toThrow("Choose a listed template");
  await deleteTemplate.run(ctx, { rowId: saved.path });
  expect(await listCatalog(files)).toEqual([]);
  expect(await files.readText("unrelated.json")).toBe("keep");
});
