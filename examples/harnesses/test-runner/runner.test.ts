import { afterEach, expect, test } from "bun:test";
import { runnerFixture } from "./runner-fixture";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});
async function fixture(files = { "package.json": "{}" }) {
  const f = await runnerFixture(files);
  cleanup.push(f.cleanup);
  return f;
}

test("runs against real Git history and uploads logs and results on test failure", async () => {
  const f = await fixture();
  f.request.command =
    "mkdir -p test-results; echo evidence > test-results/checks.json; git merge-base origin/main HEAD; echo broken >&2; exit 3";
  f.start();
  const result = await f.settled;
  expect(result).toMatchObject({
    status: "failed",
    exitCode: 3,
    log: { uploaded: true },
    results: { uploaded: true },
    source: { head: f.request.source.head.sha },
  });
  expect(new TextDecoder().decode(f.uploads.get("/log"))).toContain("broken");
  expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(f.uploads.get("/results")!)))).toContain("evidence");
});

test("rejects a source mismatch and uploads its diagnostic log", async () => {
  const f = await fixture();
  f.request.source.head.tree = "0".repeat(40);
  f.start();
  expect(await f.settled).toMatchObject({ status: "source_unavailable", exitCode: null, log: { uploaded: true } });
});

test("refuses a timeout past the workspace deadline before running the command", async () => {
  const f = await fixture();
  f.request.deadlineAt = new Date(Date.now() + 30_000).toISOString();
  f.start();
  const result = await f.settled;
  expect(result.status).toBe("prerequisite_missing");
  expect(result.preflight).toContainEqual(expect.objectContaining({ check: "workspace-deadline", ok: false }));
  expect(f.events.some((e) => e.toolCallId === "run")).toBe(false);
});

test("reports a missing engine without reporting passing tests", async () => {
  const f = await fixture();
  f.request.requires = ["docker"];
  f.start();
  expect(await f.settled).toMatchObject({ status: "prerequisite_missing", exitCode: null });
});

test("refuses mismatched browser pins", async () => {
  const f = await fixture({ "package.json": JSON.stringify({ devDependencies: { playwright: "0.0.1" } }) });
  f.request.requires = ["browsers"];
  f.start();
  const result = await f.settled;
  expect(result.status).toBe("prerequisite_missing");
  expect(result.preflight).toContainEqual(expect.objectContaining({ check: "playwright-pin", ok: false }));
});

test("keeps evidence when the command times out", async () => {
  const f = await fixture();
  f.request.timeoutSeconds = 1;
  f.request.command = "mkdir test-results; echo partial > test-results/checks.json; sleep 30";
  f.start();
  expect(await f.settled).toMatchObject({ status: "timed_out", exitCode: null, results: { uploaded: true } });
});

test("keeps cancellation and its results", async () => {
  const f = await fixture();
  f.request.command = "mkdir test-results; echo partial > test-results/checks.json; sleep 30";
  f.start();
  while (!f.events.some((e) => e.type === "tool_execution_update")) {
    if (f.events.some((e) => e.type === "agent_settled")) break;
    if (f.events.some((e) => e.toolCallId === "run")) break;
    await Bun.sleep(10);
  }
  await Bun.sleep(100);
  f.send({ type: "abort" });
  expect(await f.settled).toMatchObject({ status: "canceled", exitCode: null, results: { uploaded: true } });
});

test("rejects a concurrent reuse before replacing the active owner's source", async () => {
  const first = await fixture();
  first.request.command = "echo owner-started; sleep 1; echo owner-finished";
  first.start();
  while (!first.events.some((e) => e.type === "tool_execution_update")) await Bun.sleep(10);
  const second = await runnerFixture({ "package.json": "{}" }, { workspace: `${first.root}/workspace` });
  cleanup.push(second.cleanup);
  second.request.command = "rm package.json";
  second.start();
  expect(await second.settled).toMatchObject({ status: "error", reason: "environment_busy", exitCode: null });
  expect(await first.settled).toMatchObject({ status: "passed", exitCode: 0 });
  expect(new TextDecoder().decode(first.uploads.get("/log"))).toContain("owner-finished");
});

test("a default-stop run retains ownership until workspace teardown", async () => {
  const first = await fixture();
  first.start();
  expect((await first.settled).status).toBe("passed");
  const second = await runnerFixture({ "package.json": "{}" }, { workspace: `${first.root}/workspace` });
  cleanup.push(second.cleanup);
  second.start();
  expect(await second.settled).toMatchObject({ status: "error", reason: "environment_busy" });
});

test("an explicitly kept workspace releases ownership for its next run", async () => {
  const first = await fixture();
  first.request.releaseAfterRun = true;
  first.start();
  expect((await first.settled).status).toBe("passed");
  const second = await runnerFixture({ "package.json": "{}" }, { workspace: `${first.root}/workspace` });
  cleanup.push(second.cleanup);
  second.start();
  expect((await second.settled).status).toBe("passed");
});
