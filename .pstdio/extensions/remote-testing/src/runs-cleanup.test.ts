import { expect, test } from "bun:test";
import { createMemoryStorage } from "@pstdio/sdk/testing";
import { PocketCoderError } from "./connection";
import { checkRun, type RunRecord } from "./runs";

function finishedRun(stopAfterRun: boolean) {
  const apiCalls: string[] = [];
  const record = {
    runId: "test",
    environmentId: "env",
    requestId: "request",
    conversationId: "conversation",
    command: "bun test",
    root: "/",
    startedAt: new Date().toISOString(),
    timeoutSeconds: 30,
    stopAfterRun,
  } satisfies RunRecord;
  const deps = {
    store: createMemoryStorage(),
    async api({ method, path }) {
      apiCalls.push(`${method} ${path}`);
      if (method === "POST") return { state: "terminating" } as never;
      return {
        finalizedAt: new Date().toISOString(),
        acceptance: { execution: {} },
        outcome: {
          finalResponse: `REMOTE_TEST_RESULT ${JSON.stringify({ runId: "test", status: "failed", exitCode: 1, startedAt: new Date().toISOString(), durationMs: 100, target: { os: "linux", arch: "x64" }, preflight: [], log: { uploaded: true, bytes: 0 }, results: { uploaded: true, bytes: 0 } })}`,
        },
      } as never;
    },
    storage: {
      async download(_path: string): Promise<Uint8Array | null> {
        return new Uint8Array();
      },
    },
    async saveResults() {
      return "test.tar.gz";
    },
    async saveLog() {
      return "test.log";
    },
  } satisfies Parameters<typeof checkRun>[0];
  return { deps, record, apiCalls };
}

for (const state of ["ready", "canceled"]) {
  test(`an unaccepted submission remains pending until its environment ends: ${state}`, async () => {
    const { deps, record } = finishedRun(false);
    deps.api = async ({ path }) => {
      if (path.includes("/requests/")) throw new PocketCoderError(404, "Agent request not found.");
      return { state } as never;
    };
    deps.storage.download = async () => null;
    const summary = await checkRun(deps, record);
    if (state === "ready") expect(summary).toBeNull();
    else {
      expect(summary).toMatchObject({ status: "error", evidenceStatus: "missing", exitCode: null });
      expect(summary?.error).toContain("not accepted");
      expect(await deps.store.get(`run:${record.runId}`)).toMatchObject({ summary: { status: "error" } });
    }
  });
}

test("completed runs stop the environment by default even when the suite fails", async () => {
  const { deps, record, apiCalls } = finishedRun(true);
  const result = await checkRun(deps, record);
  expect(result?.status).toBe("failed");
  expect(apiCalls).toContain("POST /v1/workspaces/env/cancel");
  expect(await deps.store.get(`run:${record.runId}`)).toMatchObject({ summary: { status: "failed" } });
});

test("an explicit request to keep the environment preserves it", async () => {
  const { deps, record, apiCalls } = finishedRun(false);
  expect((await checkRun(deps, record))?.status).toBe("failed");
  expect(apiCalls.every((call) => call.startsWith("GET"))).toBe(true);
});

test("a rejected concurrent request cannot stop the active owner's workspace", async () => {
  const { deps, record, apiCalls } = finishedRun(true);
  const original = deps.api;
  deps.api = async (input) => {
    const receipt = await original(input);
    if (input.method === "GET") {
      const parsed = receipt as { outcome: { finalResponse: string } };
      const result = JSON.parse(parsed.outcome.finalResponse.slice("REMOTE_TEST_RESULT ".length));
      parsed.outcome.finalResponse = `REMOTE_TEST_RESULT ${JSON.stringify({ ...result, status: "error", exitCode: null, reason: "environment_busy" })}`;
    }
    return receipt;
  };
  expect((await checkRun(deps, record))?.status).toBe("error");
  expect(apiCalls).not.toContain("POST /v1/workspaces/env/cancel");
});

test("later workspace expiry cannot replace an already reported test failure", async () => {
  const { deps, record } = finishedRun(false);
  const original = deps.api;
  deps.api = async (input) =>
    input.path === "/v1/workspaces/env"
      ? ({ state: "expired", reason_code: "deadline_expired" } as never)
      : original(input);
  expect((await checkRun(deps, record))?.status).toBe("failed");
});

test("an expired lost runtime retains snapshots and never reports complete evidence", async () => {
  const { deps, record } = finishedRun(false);
  deps.api = async ({ path }) =>
    path === "/v1/workspaces/env"
      ? ({ state: "expired", reason_code: "deadline_expired" } as never)
      : ({
          finalizedAt: new Date().toISOString(),
          acceptance: { execution: {} },
          outcome: { status: "lost" },
        } as never);
  deps.storage.download = async (path: string) =>
    path.startsWith("checkpoints/") ? new TextEncoder().encode("partial evidence") : null;
  const summary = await checkRun(deps, record);
  expect(summary).toMatchObject({
    status: "timed_out",
    evidenceStatus: "partial",
    logPath: "test.log",
    resultsPath: "test.tar.gz",
    tail: "partial evidence",
  });
});

test("snapshots cannot replace final evidence for a passing result", async () => {
  const { deps, record } = finishedRun(false);
  const original = deps.api;
  deps.api = async (input) => {
    const receipt = await original(input);
    const parsed = receipt as { outcome: { finalResponse: string } };
    const result = JSON.parse(parsed.outcome.finalResponse.slice("REMOTE_TEST_RESULT ".length));
    parsed.outcome.finalResponse = `REMOTE_TEST_RESULT ${JSON.stringify({ ...result, status: "passed", exitCode: 0 })}`;
    return receipt;
  };
  deps.storage.download = async (path: string) => (path.startsWith("checkpoints/") ? new Uint8Array() : null);
  expect(await checkRun(deps, record)).toMatchObject({ status: "error", evidenceStatus: "partial" });
});
