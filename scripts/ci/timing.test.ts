import { expect, test } from "bun:test";
import { readFeedbackTimings, summarizeTimings } from "./timing";

test("PR latency includes runner wait and uses the 95th percentile", () => {
  const samples = Array.from({ length: 20 }, (_, index) => ({
    created_at: "2026-10-16T09:00:00Z",
    run_started_at: "2026-10-16T09:00:30Z",
    updated_at: new Date(Date.parse("2026-10-16T09:00:00Z") + (index + 1) * 10_000).toISOString(),
    conclusion: "success",
  }));
  expect(summarizeTimings(samples)).toMatchObject({ samples: 20, p95Seconds: 190, withinBudget: true });
});

test("cancelled updates and unfinished runs do not count as completed PR feedback", () => {
  const time = { created_at: "2026-10-16T09:00:00Z", updated_at: "2026-10-16T09:06:00Z" };
  expect(
    summarizeTimings([
      { ...time, conclusion: "cancelled" },
      { ...time, conclusion: null },
    ]),
  ).toEqual({
    samples: 0,
    p95Seconds: null,
    withinBudget: null,
  });
  expect(summarizeTimings([{ ...time, conclusion: "failure" }]).withinBudget).toBe(false);
});

test("human reruns do not turn hours of idle time into PR feedback latency", () => {
  expect(
    summarizeTimings([
      { created_at: "2026-10-16T09:00:00Z", updated_at: "2026-10-16T12:00:00Z", conclusion: "success", run_attempt: 2 },
    ]).samples,
  ).toBe(0);
});

test("opt-in full qualification does not count as fast PR feedback", () => {
  expect(
    summarizeTimings([
      {
        created_at: "2026-10-16T09:00:00Z",
        updated_at: "2026-10-16T09:20:00Z",
        conclusion: "success",
        display_title: "CI full: qualify the bootstrap",
      },
    ]).samples,
  ).toBe(0);
});

test.each(["success", "skipped"])("label metadata with %s status is not validation feedback", (conclusion) => {
  expect(
    summarizeTimings([
      {
        created_at: "2026-10-16T09:00:00Z",
        updated_at: "2026-10-16T09:00:01Z",
        conclusion,
        display_title: "Label metadata: update area tags",
      },
    ]),
  ).toEqual({ samples: 0, p95Seconds: null, withinBudget: null });
});

test.each([5, 25])(
  "reads older pages after metadata until %s eligible runs are exhausted or the sample is full",
  async (older) => {
    const run = (seconds: number, display_title = "CI fast: validate change") => ({
      created_at: "2026-10-16T09:00:00Z",
      updated_at: new Date(Date.parse("2026-10-16T09:00:00Z") + seconds * 1000).toISOString(),
      conclusion: "success",
      display_title,
    });
    const pages = [
      Array.from({ length: 50 }, () => run(1, "Label metadata: cli")),
      Array.from({ length: older }, () => run(400)),
    ];
    const requested: number[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
        requested.push(page);
        return Response.json({ workflow_runs: pages[page - 1] ?? [] });
      },
    });
    try {
      expect(await readFeedbackTimings("owner/repo", "fixture", server.url.origin)).toEqual({
        samples: Math.min(older, 20),
        p95Seconds: 400,
        withinBudget: false,
      });
      expect(requested).toEqual([1, 2]);
    } finally {
      await server.stop(true);
    }
  },
);
