import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { startCheckpoints } from "./checkpoints";
import { type CommandRun, runCommand } from "./command";
import { uploadFile, uploadResults } from "./evidence";
import { preflight } from "./preflight";
import { parseRequest, RESULT_MARKER, type RunRequest, type RunResult } from "./protocol";
import { installSource } from "./source";

const root = process.env.REMOTE_TEST_WORKSPACE ?? "/workspace";
const emit = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);
const text = (value: string) => ({ content: [{ type: "text", text: value }] });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 8192);
function result(runId: string | null): RunResult {
  return {
    runId,
    status: "error",
    exitCode: null,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    target: { os: process.platform, arch: process.arch },
    preflight: [],
    log: { uploaded: false, bytes: 0 },
    results: { uploaded: false, bytes: 0 },
  };
}
async function run(request: RunRequest, signal: AbortSignal) {
  await mkdir(root, { recursive: true });
  const lock = join(root, ".remote-test-active");
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { ...result(request.runId), reason: "environment_busy" as const, error: "Another run owns this workspace" };
  }
  try {
    return await runLocked(request, signal);
  } finally {
    if (request.releaseAfterRun) await rm(lock, { recursive: true, force: true });
  }
}
async function runLocked(request: RunRequest, signal: AbortSignal) {
  const outcome = result(request.runId),
    started = Date.now();
  const repo = join(root, "repo"),
    log = join(root, "runs", `${request.runId}.log`),
    temporary = join(root, "tmp", request.runId);
  await mkdir(join(root, "runs"), { recursive: true });
  await mkdir(temporary, { recursive: true });
  await Bun.write(log, "");
  try {
    outcome.status = "source_unavailable";
    outcome.source = await installSource(request.source, repo, signal);
    outcome.status = "prerequisite_missing";
    const checked = await preflight(request, repo);
    outcome.preflight = checked.checks;
    outcome.runtime = checked.runtime;
    await Bun.write(log, `${JSON.stringify(checked.checks)}\n`);
    if (checked.checks.every((c) => c.ok)) {
      signal.throwIfAborted();
      emit({ type: "tool_execution_start", toolCallId: "run", toolName: "bash", args: { command: request.command } });
      let lastUpdate = 0;
      const checkpoints =
        request.log.checkpointUrl && request.results.checkpointUrl
          ? startCheckpoints(async (signal) => {
              const uploads = await Promise.allSettled([
                uploadFile(request.log.checkpointUrl!, log, "text/plain", signal),
                uploadResults(
                  {
                    ...request,
                    results: {
                      ...request.results,
                      url: request.results.checkpointUrl!,
                      maxBytes: Math.min(request.results.maxBytes, 64 * 1024 ** 2),
                    },
                  },
                  repo,
                  join(root, "runs", `${request.runId}.snapshot.tar.gz`),
                  signal,
                  true,
                  temporary,
                ),
              ]);
              const failures = uploads.filter((item) => item.status === "rejected");
              if (failures.length) throw new Error(failures.map((item) => String(item.reason)).join("; "));
            })
          : undefined;
      let command: CommandRun;
      try {
        command = await runCommand({
          command: request.command,
          cwd: repo,
          logPath: log,
          timeoutSeconds: request.timeoutSeconds,
          signal,
          env: { ...process.env, CI: "1", TMPDIR: temporary, BUN_INSTALL_CACHE_DIR: join(root, ".bun-cache") },
          onOutput(tail) {
            if (Date.now() - lastUpdate < 2000) return;
            lastUpdate = Date.now();
            emit({ type: "tool_execution_update", toolCallId: "run", partialResult: text(tail) });
          },
        });
      } finally {
        for (const error of (await checkpoints?.stop()) ?? []) await appendFile(log, `Evidence snapshot: ${error}\n`);
      }

      outcome.exitCode = command.exitCode;
      if (command.aborted) outcome.status = "canceled";
      else if (command.timedOut) outcome.status = "timed_out";
      else outcome.status = command.exitCode === 0 ? "passed" : "failed";
      emit({
        type: "tool_execution_end",
        toolCallId: "run",
        result: text(command.tail),
        isError: outcome.status !== "passed",
      });
    }
  } catch (error) {
    if (signal.aborted) outcome.status = "canceled";
    outcome.error = message(error);
    await appendFile(log, `${outcome.error}\n`);
  }
  // Abort stops the test process, not evidence collection.
  // One budget covers the archive and both uploads; leave time to emit the terminal report.
  const finalization = AbortSignal.timeout(165_000);
  const uploads = [
    [
      "results",
      () => uploadResults(request, repo, join(root, "runs", `${request.runId}.tar.gz`), finalization, false, temporary),
    ],
    ["log", () => uploadFile(request.log.url, log, "text/plain", finalization)],
  ] as const;
  await Promise.all(
    uploads.map(async ([kind, upload]) => {
      try {
        outcome[kind] = await upload();
      } catch (error) {
        outcome.error = [outcome.error, message(error)].filter(Boolean).join("; ").slice(0, 8192);
        if (outcome.status === "passed") outcome.status = "error";
      }
    }),
  );
  outcome.durationMs = Date.now() - started;
  return outcome;
}
function finish(outcome: RunResult) {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `${outcome.status}\n${RESULT_MARKER}${JSON.stringify(outcome)}` }],
      // The producer owns cancellation; this transport delivered a complete report.
      stopReason: "stop",
    },
  });
  emit({ type: "agent_settled" });
}
async function main() {
  const abort = new AbortController();
  let active: Promise<void> | undefined,
    buffer = "";
  for await (const chunk of Bun.stdin.stream().pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      const command = JSON.parse(line) as { type: string; message?: string };
      if (command.type === "abort") abort.abort();
      if (command.type !== "prompt" || active) continue;
      active = (async () => {
        try {
          finish(await run(parseRequest(command.message ?? ""), abort.signal));
        } catch (error) {
          finish({ ...result(null), error: message(error) });
        }
      })();
    }
  }
  await active;
}
if (import.meta.main) await main();
