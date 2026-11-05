import { appendFile } from "node:fs/promises";

type JobResults = Record<string, { result?: string }>;

export function expectedJobs(mode: string, hasProjects: boolean, smoke: boolean, postmerge = false) {
  const jobs = ["plan", "quality"];
  if (hasProjects) jobs.push("types", "units", "stores");
  if (smoke) jobs.push("smoke");
  if (mode === "full") jobs.push("full");
  if (postmerge) jobs.push("build");
  return jobs;
}

export function assertSuccessfulJobs(results: JobResults, required: string[]) {
  const failed = [
    ...new Set([
      ...required.filter((job) => results[job]?.result !== "success"),
      ...Object.keys(results).filter((job) => ["failure", "cancelled"].includes(results[job]?.result ?? "")),
    ]),
  ];
  if (failed.length) throw new Error(`Required CI jobs did not pass: ${failed.join(", ")}`);
}

if (import.meta.main) {
  const results: JobResults = JSON.parse(process.env.CI_RESULTS ?? "{}");
  const required: string[] = process.argv.includes("--all")
    ? Object.keys(results)
    : JSON.parse(process.env.CI_REQUIRED ?? "[]");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(results).map(
      ([job, value]) => `| ${job} | ${value.result ?? "missing"} | ${required.includes(job) ? "yes" : "no"} |`,
    );
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## CI results\n\n| Job | Result | Required |\n| --- | --- | --- |\n${rows.join("\n")}\n`,
    );
  }
  if (required.length === 0) throw new Error("The CI gate requires an explicit job list");
  assertSuccessfulJobs(results, required);
  console.log(`Passed: ${required.join(", ")}`);
}
