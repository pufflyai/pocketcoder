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
        !run.display_title?.startsWith("CI full:") &&
        !run.display_title?.startsWith("Label metadata:"),
    )
    .slice(0, 20)
    .map((run) => Math.round((Date.parse(run.updated_at) - Date.parse(run.created_at)) / 1000))
    .sort((a, b) => a - b);
  const p95Seconds = times[Math.ceil(times.length * 0.95) - 1] ?? null;
  return { samples: times.length, p95Seconds, withinBudget: p95Seconds === null ? null : p95Seconds < 300 };
}

export async function readFeedbackTimings(repository: string, token: string, apiUrl = "https://api.github.com") {
  const runs: RunTiming[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(
      `${apiUrl}/repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&per_page=50&page=${page}`,
      { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
    );
    if (!response.ok) throw new Error(`Cannot read PR timings: HTTP ${response.status}`);
    const body = (await response.json()) as { workflow_runs: RunTiming[] };
    runs.push(...body.workflow_runs);
    const summary = summarizeTimings(runs);
    if (summary.samples === 20 || body.workflow_runs.length < 50) return summary;
  }
}

if (import.meta.main) {
  const { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  if (!repository || !token) throw new Error("PR timings require GITHUB_REPOSITORY and GITHUB_TOKEN.");
  const summary = await readFeedbackTimings(repository, token);
  await Bun.write("ci-timings.json", `${JSON.stringify(summary, null, 2)}\n`);
  const detail = `PR feedback: ${summary.samples} completed runs; p95 ${summary.p95Seconds ?? "unknown"} seconds. Target: <300 seconds including runner wait.\n`;
  console.log(detail);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const previous = await Bun.file(process.env.GITHUB_STEP_SUMMARY).text();
    await Bun.write(process.env.GITHUB_STEP_SUMMARY, previous + detail);
  }
}
