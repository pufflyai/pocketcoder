import {
  type RunRequest,
  type RunResult,
  RunResultSchema,
  type RunStatus,
} from "@pstdio/pocketcoder-example-test-runner/protocol";
import type { ExtensionProcessApi, ExtensionStorageApi } from "@pstdio/sdk/extensions";
import type { BranchKind, BranchSource, TemplateRef } from "./branch-templates";
import type { Api } from "./connection";
import { readEnvironment, releaseEnvironment, stopEnvironment } from "./environments";
import { logTail } from "./run-tail";
import type { Settings } from "./settings";
import type { RunStorage } from "./storage";

export interface RunDeps {
  onStarted?(record: RunRecord): Promise<unknown>;
  api: Api;
  publishTemplate?(kind: BranchKind, source: BranchSource, signal?: AbortSignal): Promise<TemplateRef>;
  storage: RunStorage;
  store: ExtensionStorageApi;
  process: ExtensionProcessApi;
  settings: Settings;
  saveLog(runId: string, text: string): Promise<string>;
  saveResults(runId: string, bytes: Uint8Array): Promise<string>;
  /** Tells open views that a run or environment changed. */
  changed?(): Promise<unknown>;
}

type RunCollectionDeps = Pick<RunDeps, "api" | "store" | "saveLog" | "saveResults" | "changed"> & {
  storage: Pick<RunStorage, "download">;
};

export interface RunRecord {
  runId: string;
  environmentId: string;
  requestId: string;
  conversationId: string;
  command: string;
  root: string;
  startedAt: string;
  timeoutSeconds: number;
  stopAfterRun?: boolean;
  /** The Prompt Studio session whose agent started the run, when one did. */
  sessionId?: string;
  source?: Omit<NonNullable<RunResult["source"]>, "mergeBase">;
  target?: RunRequest["target"];
  summary?: RunSummary;
  template?: TemplateRef;
}

export interface RunSummary {
  runId: string;
  environmentId: string;
  status: RunStatus;
  resultsPath: string | null;
  evidence?: RunResult;
  exitCode: number | null;
  durationMs: number;
  logPath: string | null;
  tail: string;
  error?: string;
}

interface Receipt {
  finalizedAt?: string | null;
  acceptance: { execution: Record<string, unknown> };
  outcome?: { status?: string; finalResponse?: string } | null;
}

const MARKER = "REMOTE_TEST_RESULT ";
const logs = (runId: string) => `logs/${runId}.log`;

export { startRun } from "./run-start";

const requestPath = (record: RunRecord) =>
  `/v1/workspaces/${record.environmentId}/requests/${record.requestId}?conversationId=${record.conversationId}`;

export async function awaitRun(deps: RunDeps, record: RunRecord, signal?: AbortSignal): Promise<RunSummary> {
  let summary = await checkRun(deps, record, signal);
  while (!summary) {
    await Bun.sleep(3000);
    signal?.throwIfAborted();
    summary = await checkRun(deps, record, signal);
  }
  return summary;
}

// One look at a run: collects its result once the controller has finished it, so a run
// whose caller went away still gets its summary and log.
export async function checkRun(deps: RunCollectionDeps, record: RunRecord, signal?: AbortSignal) {
  if (record.summary) return record.summary;
  const receipt = await deps.api<Receipt>({ method: "GET", path: requestPath(record), signal });
  if (!receipt.finalizedAt) return null;
  const environment = await readEnvironment(deps.api, record.environmentId, signal);
  const summary = await summarize(deps, record, receipt);
  if (!summary.evidence && (environment.state === "expired" || environment.reason_code === "deadline_expired"))
    summary.status = "timed_out";
  // A rejected concurrent request owns no runtime and must never stop the active owner.
  if (record.stopAfterRun && summary.evidence?.reason !== "environment_busy")
    await stopEnvironment(deps.api, record.environmentId, signal);
  await deps.store.set(`run:${record.runId}`, { ...record, summary });
  await releaseEnvironment(deps.store, record.environmentId, record.runId);
  await deps.changed?.();
  return summary;
}

async function summarize(deps: RunCollectionDeps, record: RunRecord, receipt: Receipt): Promise<RunSummary> {
  const response = receipt.outcome?.finalResponse ?? "";
  const line = response.split("\n").find((text) => text.startsWith(MARKER));
  let result: RunResult | null = null;
  try {
    result = line ? RunResultSchema.parse(JSON.parse(line.slice(MARKER.length))) : null;
  } catch {
    /* A malformed result is an error with its original log retained. */
  }
  const log = await deps.storage.download(logs(record.runId));
  const text = log ? new TextDecoder().decode(log) : "";
  const logPath = log ? await deps.saveLog(record.runId, text) : null;
  const results = await deps.storage.download(`results/${record.runId}.tar.gz`);
  const resultsPath = results ? await deps.saveResults(record.runId, results) : null;
  const base = {
    resultsPath,
    ...(result ? { evidence: result } : {}),
    runId: record.runId,
    environmentId: record.environmentId,
    exitCode: result?.exitCode ?? null,
    durationMs: result?.durationMs ?? Date.now() - Date.parse(record.startedAt),
    logPath,
    tail: logTail(text),
  };
  if (receipt.outcome?.status === "canceled") return { ...base, status: "canceled" };
  if (!result) return { ...base, status: "error", error: (response || JSON.stringify(receipt.outcome)).slice(0, 8192) };
  const mismatch = evidenceMismatch(record, result);
  if (mismatch) return { ...base, status: "error", error: mismatch };
  const status = result.status;
  const valid = [
    "passed",
    "failed",
    "timed_out",
    "canceled",
    "error",
    "prerequisite_missing",
    "source_unavailable",
  ].includes(status);
  if (!valid || result.runId !== record.runId) return { ...base, status: "error", error: "Invalid run result" };
  if (
    status === "passed" &&
    (result.exitCode !== 0 || !result.log.uploaded || !result.results.uploaded || !log || !results)
  )
    return { ...base, status: "error", error: "Passing result is missing successful execution or evidence" };
  return { ...base, status, ...(result.error ? { error: result.error } : {}) };
}

export async function cancelRun(deps: RunDeps, record: RunRecord) {
  const receipt = await deps.api<Receipt>({ method: "GET", path: requestPath(record) });
  if (receipt.finalizedAt) return false;
  await deps.api({
    method: "POST",
    path: `/v1/workspaces/${record.environmentId}/executions/${record.requestId}/cancel`,
    body: { execution: receipt.acceptance.execution as never, cancelId: crypto.randomUUID(), scope: "operation" },
  });
  return true;
}

export async function listRuns(store: ExtensionStorageApi) {
  const records = await store.records.list();
  return records
    .filter((record) => record.exists && !record.deleted)
    .map((record) => record.value as unknown as RunRecord)
    .filter(
      (record) =>
        record &&
        typeof record === "object" &&
        typeof record.runId === "string" &&
        typeof record.environmentId === "string" &&
        typeof record.command === "string",
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function readRun(store: ExtensionStorageApi, runId: string) {
  const record = await store.get<RunRecord>(`run:${runId}`);
  if (!record) throw new Error(`Unknown run ${runId}. List runs with: pst pocketcoder.remote-testing runs list`);
  return record;
}

function evidenceMismatch(record: RunRecord, result: RunResult) {
  if (
    record.source &&
    (!result.source ||
      Object.entries(record.source).some(
        ([key, value]) => result.source?.[key as keyof typeof result.source] !== value,
      ))
  )
    return "Run source differs from the requested revision";
  if (record.target && (result.target.os !== record.target.os || result.target.arch !== record.target.arch))
    return "Run target differs from the requested host";
  return null;
}
