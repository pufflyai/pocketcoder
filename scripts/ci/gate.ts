type JobResults = Record<string, { result?: string }>;

export function expectedJobs(mode: string, hasProjects: boolean, smoke: boolean, postmerge = false) {
  const jobs = ["plan", "quality"];
  if (hasProjects) jobs.push("types", "units");
  if (smoke) jobs.push("smoke");
  if (mode === "full") jobs.push("full");
  if (postmerge) jobs.push("build");
  return jobs;
}

export function assertSuccessfulJobs(results: JobResults, required: string[]) {
  const failed = required.filter((job) => results[job]?.result !== "success");
  if (failed.length) throw new Error(`Required CI jobs did not pass: ${failed.join(", ")}`);
}

if (import.meta.main) {
  const results: JobResults = JSON.parse(process.env.CI_RESULTS ?? "{}");
  const required: string[] = JSON.parse(process.env.CI_REQUIRED ?? "[]");
  if (required.length === 0) throw new Error("The CI gate requires an explicit job list");
  assertSuccessfulJobs(results, required);
  console.log(`Passed: ${required.join(", ")}`);
}
