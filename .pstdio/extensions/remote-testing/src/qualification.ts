import type { RunStatus } from "@pstdio/pocketcoder-example-test-runner/protocol";
import type { ExtensionStorageApi } from "@pstdio/sdk/extensions";
import { QUALIFICATION_COMMAND } from "./qualification-plan";
import type { RunDeps } from "./runs";
import { awaitRun, checkRun, readRun, startRun } from "./runs";
import { DISCOVERY_COMMAND, requiredTargets } from "./target-discovery";

export { requiredTargets } from "./target-discovery";
export function qualificationStatus(targets: string[], statuses: Record<string, RunStatus | undefined>) {
  if (
    Object.values(statuses).some(
      (s) =>
        s === "failed" ||
        s === "error" ||
        s === "prerequisite_missing" ||
        s === "source_unavailable" ||
        s === "timed_out",
    )
  )
    return "failed";
  return targets.length > 0 && targets.every((target) => statuses[target] === "passed") ? "passed" : "incomplete";
}
export interface SuiteRecord {
  discoveryRunId?: string;
  suiteId: string;
  root: string;
  head: string;
  base: string;
  requiredTargets: string[];
  runs: Record<string, string>;
  unavailable: Record<string, "no_worker">;
  errors: Record<string, string>;
  status: "passed" | "failed" | "incomplete";
  coverage: "partial" | "complete";
  startedAt: string;
}
export async function startQualification(
  deps: RunDeps,
  input: { root: string; ref?: string; sessionId?: string },
  signal?: AbortSignal,
) {
  const git = async (...args: string[]) =>
    (await deps.process.runOrThrow({ command: ["git", "-C", input.root, ...args], timeoutMs: 30_000 })).stdout.trim();
  const head = await git("rev-parse", "--verify", "--end-of-options", `${input.ref ?? "HEAD"}^{commit}`);
  const base = await git("rev-parse", "refs/remotes/origin/main");

  const templates = deps.settings.qualificationTemplates ?? {};
  const suite: SuiteRecord = {
    suiteId: crypto.randomUUID(),
    root: input.root,
    head,
    base,
    requiredTargets: [],
    runs: {},
    unavailable: {},
    errors: {},
    status: "incomplete",
    coverage: "partial",
    startedAt: new Date().toISOString(),
  };
  await deps.store.set(`suite:${suite.suiteId}`, suite);

  try {
    const discoveryTemplate = templates["linux-x64"] ?? templates["linux-arm64"];
    if (!discoveryTemplate) throw new Error("Candidate discovery requires an approved Linux qualification template");
    const discovery = await startRun(
      deps,
      {
        root: input.root,
        ref: head,
        baseSha: base,
        sessionId: input.sessionId,
        command: DISCOVERY_COMMAND,
        template: discoveryTemplate,
        requires: ["git-history"],
      },
      signal,
    );
    suite.discoveryRunId = discovery.record.runId;
    await deps.store.set(`suite:${suite.suiteId}`, suite);
    const summary = await awaitRun(deps, discovery.record, signal);
    if (summary.status !== "passed") throw new Error(`Candidate platform discovery ${summary.status}`);
    suite.requiredTargets = requiredTargets(summary.tail);
  } catch (error) {
    suite.errors.discovery = error instanceof Error ? error.message : String(error);
    return collectQualification(deps, suite);
  }
  for (const target of suite.requiredTargets) {
    const template = templates[target];
    if (!template) suite.unavailable[target] = "no_worker";
    else {
      try {
        signal?.throwIfAborted();
        const [os, arch] = target.split("-");
        const started = await startRun(
          deps,
          {
            root: input.root,
            ref: head,
            baseSha: base,
            sessionId: input.sessionId,
            command: QUALIFICATION_COMMAND,
            template,
            requires: ["git-history", "docker", "browsers"],
            target: { os: os!, arch: arch! },
          },
          signal,
        );
        suite.runs[target] = started.record.runId;
      } catch (error) {
        suite.errors[target] = error instanceof Error ? error.message : String(error);
      }
    }
    await deps.store.set(`suite:${suite.suiteId}`, suite);
  }
  return collectQualification(deps, suite);
}
export async function readQualification(store: ExtensionStorageApi, suiteId: string) {
  const record = await store.get<SuiteRecord>(`suite:${suiteId}`);
  if (!record) throw new Error(`Unknown suite ${suiteId}`);
  return record;
}
export async function collectQualification(deps: RunDeps, suite: SuiteRecord) {
  const statuses: Record<string, RunStatus | undefined> = {};
  for (const [target, runId] of Object.entries(suite.runs)) {
    const run = await readRun(deps.store, runId);
    if (run.source?.head !== suite.head || run.source.base !== suite.base)
      suite.errors[target] = "Run source differs from its suite";
    statuses[target] = (await checkRun(deps, run))?.status;
  }
  for (const target of Object.keys(suite.errors)) statuses[target] = "error";
  suite.status = qualificationStatus(suite.requiredTargets, statuses);
  suite.coverage =
    suite.requiredTargets.length > 0 && suite.requiredTargets.every((target) => Boolean(suite.runs[target]))
      ? "complete"
      : "partial";
  await deps.store.set(`suite:${suite.suiteId}`, suite);
  return suite;
}
