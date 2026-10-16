type RunTiming = {
  created_at: string;
  updated_at: string;
  conclusion: string | null;
  run_attempt?: number;
  display_title?: string;
};

export function summarizeTimings(runs: RunTiming[]) {
  const times = runs
    .filter(
      (run) =>
        run.conclusion &&
        run.conclusion !== "cancelled" &&
        (run.run_attempt ?? 1) === 1 &&
        !run.display_title?.startsWith("CI full:"),
    )
    .slice(0, 20)
    .map((run) => Math.round((Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000))
    .sort((a, b) => a - b);
  const p95Seconds = times[Math.ceil(times.length * 0.95) - 1] ?? null;
  return { samples: times.length, p95Seconds, withinBudget: p95Seconds === null ? null : p95Seconds < 300 };
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&per_page=50`,
    { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" } },
  );
  if (!response.ok) throw new Error(`Cannot read PR timings: HTTP ${response.status}`);
  const body = (await response.json()) as { workflow_runs: RunTiming[] };
  const summary = summarizeTimings(body.workflow_runs);
  await Bun.write("ci-timings.json", `${JSON.stringify(summary, null, 2)}\n`);
  const detail = `PR feedback: ${summary.samples} completed runs; p95 ${summary.p95Seconds ?? "unknown"} seconds. Target: <300 seconds including runner wait.\n`;
  console.log(detail);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const previous = await Bun.file(process.env.GITHUB_STEP_SUMMARY).text();
    await Bun.write(process.env.GITHUB_STEP_SUMMARY, previous + detail);
  }
}
