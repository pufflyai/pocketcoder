import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, ExecutionRecordSchema } from "@pstdio/pocketcoder-contracts";
import { authed } from "../testing/test-server.test";
import { dockerExecutionFixture, executionDockerImage } from "./execution-docker-fixture.test";

const available =
  Bun.spawnSync(["docker", "image", "inspect", executionDockerImage], { stdout: "ignore", stderr: "ignore" })
    .exitCode === 0;

test.skipIf(!available).each([1, 5, 20])(
  "public execution API qualifies %s Docker attempts within measured capacity",
  async (concurrency) => {
    const f = await dockerExecutionFixture();
    const startedAt = performance.now();
    try {
      const capacity = Bun.spawnSync(["docker", "info", "--format", "{{json .}}"], { stdout: "pipe", stderr: "pipe" });
      const measured = JSON.parse(capacity.stdout.toString());
      expect(measured.NCPU).toBeGreaterThanOrEqual(concurrency * 0.1);
      expect(measured.MemTotal).toBeGreaterThan(concurrency * 256 * 1024 * 1024);
      const requestId = randomUUID();
      const attempts = await Promise.all(
        Array.from({ length: concurrency }, (_, index) => f.prepare(index < 2 && concurrency <= 5, requestId)),
      );
      const responses = await Promise.all(
        attempts.map(async (a) => {
          const path = `/v1/workspaces/${a.workspace.id}/executions`;
          const post = () =>
            f.app.request(
              path,
              authed(a.token, { method: "POST", body: JSON.stringify({ acceptance: a.acceptance }) }),
            );
          if (a.acceptance.inputs.objects.length) {
            const contents = {
              workspaceId: a.workspace.id,
              incarnationId: a.acceptance.execution.incarnationId,
              objects: a.acceptance.inputs.objects.map((object) => ({ ...object, name: "different.txt" })),
            };
            const { fingerprint: _fingerprint, ...facts } = a.acceptance;
            const changed = { ...facts, inputs: { ...contents, digest: digestOf(contents) } };
            const refused = await f.app.request(
              path,
              authed(a.token, {
                method: "POST",
                body: JSON.stringify({ acceptance: { ...changed, fingerprint: digestOf(changed) } }),
              }),
            );
            expect(refused.status).toBe(409);
          }
          const [first, retry] = await Promise.all([post(), post()]);
          expect([first.status, retry.status].sort()).toEqual([200, 201]);
          expect(ExecutionRecordSchema.parse(await first.json()).acceptance).toEqual(a.acceptance);
          return a;
        }),
      );
      await f.executionDispatcher.tick();
      await f.waitFor(async () =>
        (await Promise.all(responses.map((a) => f.store.executions.get(a.acceptance.execution)))).every(
          (r) => r?.phase === "terminal",
        ),
      );
      for (const a of responses) {
        const fact = (await f.store.getWorkspace(a.workspace.id))?.finiteProcess;
        expect(fact).toMatchObject({ execution: a.acceptance.execution, phase: "exited", exitCode: 7, signal: null });
        const observe = `/v1/workspaces/${a.workspace.id}/executions/${a.acceptance.execution.requestId}?owner=process&incarnationId=${encodeURIComponent(a.acceptance.execution.incarnationId)}`;
        const result = await f.app.request(observe, authed(a.token));
        expect(result.status).toBe(200);
        expect(ExecutionRecordSchema.parse(await result.json()).outcome).toMatchObject({ exitCode: 7, signal: null });
        const cancel = await f.app.request(
          `/v1/workspaces/${a.workspace.id}/executions/${a.acceptance.execution.requestId}/cancel`,
          authed(a.token, {
            method: "POST",
            body: JSON.stringify({ execution: a.acceptance.execution, cancelId: randomUUID(), scope: "operation" }),
          }),
        );
        expect(ExecutionRecordSchema.parse(await cancel.json()).phase).toBe("terminal");
      }
      if (concurrency === 1) await cancelDuringPublication(f);
      console.log(
        JSON.stringify({
          gate: "PC-129",
          attempts: concurrency,
          elapsedMs: Math.round(performance.now() - startedAt),
          dockerCpus: measured.NCPU,
          dockerMemoryBytes: measured.MemTotal,
          image: executionDockerImage,
          installedProducerDigest: f.producerDigest,
          storage: "controller-readonly/v1",
          runtimes: responses.map(({ acceptance, installed }) => ({
            execution: acceptance.execution,
            storage: installed.storage,
          })),
          bounds: { cpuPerRuntime: 0.1, memoryMiBPerRuntime: 256, deadlineSeconds: 600, finalizationSeconds: 30 },
        }),
      );
    } finally {
      await f.dispose();
    }
  },
  60_000,
);

async function cancelDuringPublication(f: Awaited<ReturnType<typeof dockerExecutionFixture>>) {
  const a = await f.prepare(true);
  await f.store.executions.accept(a.acceptance, new Date());
  const original = f.driver.publishInputs.bind(f.driver);
  let resume: (() => void) | undefined;
  let publishing: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const started = new Promise<void>((resolve) => {
    publishing = resolve;
  });
  f.driver.publishInputs = async (ref, input) => {
    publishing?.();
    await gate;
    return original(ref, input);
  };
  const dispatch = f.executionDispatcher.tick();
  try {
    await started;
    const response = await f.app.request(
      `/v1/workspaces/${a.workspace.id}/executions/${a.acceptance.execution.requestId}/cancel`,
      authed(a.token, {
        method: "POST",
        body: JSON.stringify({ execution: a.acceptance.execution, cancelId: randomUUID(), scope: "operation" }),
      }),
    );
    expect(response.status).toBe(200);
    await f.waitFor(async () => (await f.store.executions.get(a.acceptance.execution))?.phase === "canceled");
    resume?.();
    await dispatch;
    await f.executionDispatcher.drain();
    await f.waitFor(async () => (await f.store.executions.get(a.acceptance.execution))?.phase === "canceled");
    expect((await f.store.getWorkspace(a.workspace.id))?.finiteProcess).toBeNull();
  } finally {
    resume?.();
    await dispatch;
    await f.executionDispatcher.drain();
    f.driver.publishInputs = original;
  }
}

test.skipIf(!available)(
  "Docker cancellation stops descendants after their leader exits",
  async () => {
    const f = await dockerExecutionFixture(
      [
        "/bin/sh",
        "-c",
        "(trap '' TERM; touch /tmp/child-ready; while :; do sleep 1; done) >/dev/null 2>&1 & echo $! > /tmp/child-pid; wait",
      ],
      1,
    );
    try {
      const a = await f.prepare(false);
      await f.store.executions.accept(a.acceptance, new Date());
      await f.executionDispatcher.tick();
      await f.waitFor(
        async () =>
          Bun.spawnSync(["docker", "exec", a.ref.id, "test", "-f", "/tmp/child-ready"], {
            stdout: "ignore",
            stderr: "ignore",
          }).exitCode === 0,
      );
      const child = Bun.spawnSync(["docker", "exec", a.ref.id, "cat", "/tmp/child-pid"]).stdout.toString().trim();
      await f.store.executions.cancel(
        { execution: a.acceptance.execution, cancelId: randomUUID(), scope: "operation" },
        new Date(),
      );
      await f.executionDispatcher.tick();
      await f.waitFor(async () => (await f.store.executions.get(a.acceptance.execution))?.phase === "terminal");
      const stopped = Bun.spawnSync(["docker", "exec", a.ref.id, "cat", `/proc/${child}/stat`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (stopped.exitCode === 0) {
        const stat = stopped.stdout.toString();
        expect(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]).toBe("Z");
      } else expect(stopped.stderr.toString()).toContain("No such file or directory");
      expect((await f.store.getWorkspace(a.workspace.id))?.finiteProcess?.signal).toBe("SIGTERM");
    } finally {
      await f.dispose();
    }
  },
  30_000,
);
