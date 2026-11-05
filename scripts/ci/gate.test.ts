import { expect, test } from "bun:test";
import { assertSuccessfulJobs, expectedJobs } from "./gate";

test.each(["failure", "cancelled", "skipped", undefined])("%s cannot satisfy a required job", (result) => {
  expect(() => assertSuccessfulJobs({ quality: { result } }, ["quality"])).toThrow("quality");
});

test("missing matrix or reusable workflow results block the gate", () => {
  expect(() => assertSuccessfulJobs({ quality: { result: "success" } }, ["quality", "images"])).toThrow("images");
});

test("only deliberately unselected jobs can be skipped on a docs update", () => {
  const required = expectedJobs("fast", false, false);
  expect(required).toEqual(["plan", "quality"]);
  expect(() =>
    assertSuccessfulJobs(
      { plan: { result: "success" }, quality: { result: "success" }, units: { result: "skipped" } },
      required,
    ),
  ).not.toThrow();
});

test("full qualification is required even when the change has no affected packages", () => {
  expect(expectedJobs("full", false, false)).toContain("full");
});

test("protected branch pushes must finish their build and package checks", () => {
  expect(expectedJobs("fast", false, false, true)).toContain("build");
});

test("affected packages also run the store suites on PostgreSQL", () => {
  expect(expectedJobs("fast", true, false)).toContain("stores");
});

test.each(["failure", "cancelled"])("an unlisted job with %s still blocks CI", (result) => {
  expect(() => assertSuccessfulJobs({ quality: { result: "success" }, helm: { result } }, ["quality"])).toThrow("helm");
});

test.each(["failure", "cancelled", "skipped"])(
  "the full gate requires every dependency, including %s",
  async (result) => {
    const child = Bun.spawn([process.execPath, new URL("gate.ts", import.meta.url).pathname, "--all"], {
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: "",
        CI_REQUIRED: '["quality"]',
        CI_RESULTS: JSON.stringify({ quality: { result: "success" }, helm: { result } }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(error).toContain("helm");
  },
);
