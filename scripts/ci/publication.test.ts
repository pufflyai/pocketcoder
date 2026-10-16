import { expect, test } from "bun:test";
import { publicationPolicy, validatedRun } from "./publication";

const run = {
  conclusion: "success",
  event: "push",
  head_branch: "main",
  head_sha: "a".repeat(40),
  head_repository: { full_name: "pufflyai/pocketcoder" },
};

test("publishing accepts only successful CI pushes from the protected repository and branch", () => {
  expect(validatedRun(run, "pufflyai/pocketcoder", "main")).toBe(run.head_sha);
  for (const change of [
    { conclusion: "failure" },
    { event: "pull_request" },
    { head_branch: "other" },
    { head_repository: { full_name: "fork/pocketcoder" } },
  ]) {
    expect(() => validatedRun({ ...run, ...change }, "pufflyai/pocketcoder", "main")).toThrow();
  }
});

test("a validated version tag can publish an older release without moving latest", () => {
  expect(publicationPolicy("new", "old", true)).toEqual({ publish: true, latest: false });
  expect(publicationPolicy("new", "old", false)).toEqual({ publish: false, latest: false });
  expect(publicationPolicy("same", "same", false)).toEqual({ publish: true, latest: true });
});
