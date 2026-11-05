import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparisonBase } from "./diff";

test("PR selection excludes upstream edits when event metadata lags the tested merge parent", () => {
  const root = mkdtempSync(join(tmpdir(), "pocketcoder-ci-diff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const commit = (path: string) => {
    writeFileSync(join(root, path), path);
    git("add", path);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", path);
  };
  try {
    git("init", "--quiet", "--initial-branch=main");
    commit("original");
    const staleBase = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "-b", "feature");
    commit("feature-change");
    commit("second-feature-change");
    git("checkout", "--quiet", "main");
    commit("upstream-only-change");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "merge",
      "--quiet",
      "--no-ff",
      "feature",
      "-m",
      "candidate",
    );
    const head = git("rev-parse", "HEAD");
    const base = comparisonBase("pull_request", head, staleBase);
    expect(git("rev-parse", String(base))).toBe(git("rev-parse", "HEAD^1"));
    expect(git("diff", "--name-only", `${base}...${head}`).split("\n")).toEqual([
      "feature-change",
      "second-feature-change",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pushes compare with the previous revision and new branches select everything", () => {
  expect(comparisonBase("push", "head", "previous")).toBe("previous");
  expect(comparisonBase("push", "head", "0".repeat(40))).toBeUndefined();
  expect(comparisonBase("workflow_dispatch", "head")).toBeUndefined();
});
