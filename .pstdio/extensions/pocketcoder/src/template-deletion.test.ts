import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createMemoryRepoFiles, createMemoryStorage, makeCommandContext } from "@pstdio/sdk/testing";
import { listCatalog, templateDirectory } from "./template-catalog";
import { deleteTemplates } from "./template-commands";

// Directory permissions need a non-root host user to refuse deletion.
test.skipIf(process.getuid?.() === 0)(
  "partial deletion reports failed files, tries later files, and refreshes the catalog",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pc-template-deletion-"));
    const deniedPath = `${templateDirectory}/b/denied.json`;
    const paths = [`${templateDirectory}/a/first.json`, deniedPath, `${templateDirectory}/c/last.json`];
    const denied = join(root, dirname(deniedPath));
    const events: string[] = [];
    const files = {
      ...createMemoryRepoFiles(),
      writeText: async (path: string, source: string) => {
        await Bun.write(join(root, path), source);
      },
      readText: (path: string) => Bun.file(join(root, path)).text(),
      list: async (pattern = "**/*") => {
        const entries = [];
        for await (const path of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
          const info = await stat(join(root, path));
          entries.push({ path, size: info.size, updatedAt: info.mtime.toISOString() });
        }
        return entries;
      },
      delete: (path: string) => rm(join(root, path)),
    };
    const ctx = makeCommandContext({
      projectId: "test",
      params: {},
      storage: createMemoryStorage(),
      overrides: {
        projectFiles: files,
        events: {
          emit: async (event) => {
            events.push(typeof event === "string" ? event : event.id);
            return { delivered: 0 };
          },
        },
      },
    });
    try {
      for (const [index, path] of paths.entries())
        await files.writeText(
          path,
          JSON.stringify({
            apiVersion: "pocketcoder.dev/v1",
            kind: "Template",
            metadata: { name: `template-${index}` },
            spec: { version: "1.0.0" },
          }),
        );
      await chmod(denied, 0o555);
      await expect(deleteTemplates.run(ctx, { rowIds: paths })).rejects.toThrow(deniedPath);
      expect((await listCatalog(files)).map((file) => file.path)).toEqual([deniedPath]);
      expect(events).toHaveLength(1);
    } finally {
      await chmod(denied, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  },
);
