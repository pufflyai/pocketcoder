import { expect, test } from "bun:test";
import { selectProjects, validationMode } from "./selection";

const all = ["@pstdio/pocketcoder-db", "@pstdio/pocketcoder-server"];

test("package changes keep affected dependents and select the real runtime smoke", () => {
  expect(selectProjects(["packages/db/src/store.ts"], all, all)).toEqual({ projects: all, smoke: true });
});

test("documentation updates need global checks without runtime jobs", () => {
  expect(selectProjects(["docs/api.md", "AGENTS.md", ".changeset/tidy.md"], [], all)).toEqual({
    projects: [],
    smoke: false,
  });
});

test.each(["bun.lock", "scripts/build-pglite-seed.ts", ".github/workflows/ci.yml", "new-config.json"])(
  "%s selects all projects instead of silently losing coverage",
  (path) => expect(selectProjects([path], [], all)).toEqual({ projects: all, smoke: true }),
);

test("a package change with no Nx owner selects all projects", () => {
  expect(selectProjects(["packages/new-package/index.ts"], [], all).projects).toEqual(all);
});

test("a merge group always receives full validation", () => {
  expect(validationMode("merge_group", false)).toBe("full");
  expect(validationMode("pull_request", false)).toBe("fast");
  expect(validationMode("workflow_dispatch", true)).toBe("full");
});
