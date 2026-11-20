import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { startController } from "./controller-fixture";
import { createEnvironment, listEnvironments, stopEnvironment } from "./environments";
import { localProcess } from "./process-fixture";
import { awaitRun, checkRun, readRun, startRun } from "./runs";

let controller: Awaited<ReturnType<typeof startController>>;
let repository: string;

beforeAll(async () => {
  controller = await startController();
  repository = await mkdtemp(join(tmpdir(), "remote-testing-repo-"));
  await localProcess.runOrThrow({ command: ["git", "-C", repository, "init", "-q"] });
  await writeFile(join(repository, "suite.sh"), 'echo "suite ran on $(uname -s)"; exit "${1:-0}"');
  for (const args of [
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-qm", "source"],
    ["update-ref", "refs/remotes/origin/main", "HEAD"],
  ])
    await localProcess.runOrThrow({ command: ["git", "-C", repository, ...args] });
}, 300_000);

afterAll(async () => {
  for (const environment of await listEnvironments(controller.deps.api, controller.deps.settings))
    await stopEnvironment(controller.deps.api, environment.id);
  await rm(repository, { recursive: true, force: true });
  await controller.stop();
}, 120_000);

test("isolates projects and reuses a kept environment only when requested", async () => {
  const first = await startRun(controller.deps, { root: repository, command: "sh suite.sh 0", keepEnvironment: true });
  const passed = await awaitRun(controller.deps, first.record);
  expect(passed).toMatchObject({ status: "passed", exitCode: 0 });
  expect(await Bun.file(passed.logPath!).text()).toContain("suite ran on Linux");

  const otherProject = { ...controller.deps, store: createMemoryStorage() };
  const isolated = await startRun(otherProject, { root: repository, command: "sh suite.sh 0" });
  expect(isolated.record.environmentId).not.toBe(first.record.environmentId);
  expect((await awaitRun(otherProject, isolated.record)).status).toBe("passed");

  const second = await startRun(controller.deps, {
    root: repository,
    command: "sh suite.sh 4",
    environmentId: first.record.environmentId,
  });
  const failed = await awaitRun(controller.deps, second.record);
  expect(failed).toMatchObject({ status: "failed", exitCode: 4, environmentId: passed.environmentId });
  expect(failed.tail).toContain("suite ran on Linux");
  expect(
    (await listEnvironments(controller.deps.api, controller.deps.settings)).some(
      (item) => item.id === passed.environmentId,
    ),
  ).toBe(false);
}, 300_000);

test("records the starting session and collects a run whose caller went away", async () => {
  const started = await startRun(controller.deps, {
    root: repository,
    command: "sh suite.sh 0",
    sessionId: "session-1",
  });
  expect(started.record.sessionId).toBe("session-1");

  // Nobody awaits the run; a later look, as the runs table does, collects its result.
  let summary = await checkRun(controller.deps, started.record);
  while (!summary) {
    await Bun.sleep(1000);
    summary = await checkRun(controller.deps, started.record);
  }
  expect(summary).toMatchObject({ status: "passed", exitCode: 0 });
  expect((await readRun(controller.deps.store, started.record.runId)).summary?.status).toBe("passed");
}, 300_000);

test("setup failures stop newly created environments and preserve explicitly selected ones", async () => {
  const deps = {
    ...controller.deps,
    api: <T>(input: Parameters<typeof controller.deps.api>[0]) =>
      controller.deps.api<T>(input.path.endsWith("/requests") ? { ...input, body: {} } : input),
  };
  await expect(startRun(deps, { root: repository, command: "true" })).rejects.toThrow("400");
  expect(await listEnvironments(deps.api, deps.settings)).toHaveLength(0);

  const selected = await createEnvironment(deps.api, deps.settings);
  await expect(startRun(deps, { root: repository, command: "true", environmentId: selected.id })).rejects.toThrow(
    "400",
  );
  expect((await listEnvironments(deps.api, deps.settings)).map((item) => item.id)).toContain(selected.id);
  await stopEnvironment(deps.api, selected.id);
}, 300_000);
