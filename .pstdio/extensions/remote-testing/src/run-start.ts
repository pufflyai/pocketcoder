import type { RunRequest } from "@pstdio/pocketcoder-example-test-runner/protocol";
import type { BranchKind } from "./branch-templates";
import {
  claimEnvironment,
  createEnvironment,
  readEnvironment,
  releaseEnvironment,
  stopEnvironment,
  waitUntilReady,
} from "./environments";
import { withGitSource } from "./git-source";
import { runUrlLifetime } from "./run-url-lifetime";
import type { RunDeps, RunRecord } from "./runs";
import { withSourceArchive } from "./source";

export async function startRun(
  deps: RunDeps,
  input: {
    root: string;
    command?: string;
    environmentId?: string;
    timeoutMinutes?: number;
    sessionId?: string;
    keepEnvironment?: boolean;
    ref?: string;
    baseSha?: string;
    kind?: BranchKind;
    branchTemplate?: boolean;
    requires?: RunRequest["requires"];
    target?: RunRequest["target"];
    template?: { name: string; version: string };
  },
  signal?: AbortSignal,
) {
  const runId = crypto.randomUUID(),
    command = input.command?.trim() || deps.settings.testCommand;
  const timeoutSeconds = Math.round((input.timeoutMinutes ?? deps.settings.timeoutMinutes) * 60);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 6 * 3600)
    throw new Error("Invalid run timeout");
  const kind = input.kind ?? "tests";
  let template = input.template;
  if (kind === "preview" || input.branchTemplate) {
    if (input.environmentId) throw new Error("A branch template needs a new environment.");
    template = await withSourceArchive(deps.process, input.root, input.ref, async (source) => {
      const published = await deps.publishTemplate?.(kind, source, signal);
      if (!published) throw new Error("Branch template publishing is unavailable.");
      return published;
    });
  }
  const source = await uploadSource(deps, input.root, input.ref, runId, input.baseSha);
  const settings = template
    ? { ...deps.settings, templateName: template.name, templateVersion: template.version }
    : deps.settings;
  const environment = input.environmentId
    ? await readEnvironment(deps.api, input.environmentId, signal)
    : await createEnvironment(deps.api, settings, signal);
  try {
    if (!(await claimEnvironment(deps.store, environment.id, runId, timeoutSeconds + 1800)))
      throw new Error(`Environment ${environment.id} is running another test run.`);
    const ready = await waitUntilReady(deps.api, environment, signal);
    if (!ready.deadline_at) throw new Error("Workspace deadline is unavailable");
    const request = await requestFor(deps, {
      runId,
      source,
      command,
      timeoutSeconds,
      ready,
      requires: input.requires,
      target: input.target,
      releaseAfterRun: Boolean(input.keepEnvironment),
    });
    const record: RunRecord = {
      runId,
      environmentId: ready.id,
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      command,
      root: input.root,
      startedAt: new Date().toISOString(),
      timeoutSeconds,
      stopAfterRun: !input.keepEnvironment,
      source: { kind: source.kind, head: source.head.sha, base: source.base.sha, tree: source.head.tree },
      ...(input.target ? { target: input.target } : {}),
      ...(template ? { template } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    };
    await deps.store.set(`run:${runId}`, record);

    await deps.api({
      method: "POST",
      path: `/v1/workspaces/${ready.id}/requests`,
      body: {
        requestId: record.requestId,
        conversationId: record.conversationId,
        message: JSON.stringify(request),
        files: [],
      },
      signal,
    });
    await deps.onStarted?.(record);
    await deps.changed?.();
    return { record };
  } catch (error) {
    if (!input.environmentId) await stopEnvironment(deps.api, environment.id).catch(() => {});
    await releaseEnvironment(deps.store, environment.id, runId);
    throw error;
  }
}

async function uploadSource(deps: RunDeps, root: string, ref: string | undefined, runId: string, baseSha?: string) {
  return withGitSource(
    deps.process,
    root,
    ref,
    async (packed) => {
      for (const [name, object] of Object.entries(packed.objects)) {
        const key =
          name === "base.bundle"
            ? `bundles/base-${packed.source.base.sha}-${object.reference.sha256}.bundle`
            : `sources/${runId}/${name}`;
        if (name !== "base.bundle" || !(await deps.storage.exists(key))) await deps.storage.upload(key, object.file);
        // No reusable Git or storage credential crosses the workspace boundary.
        object.reference.url = key;
      }
      return packed.source;
    },
    baseSha,
  );
}

async function requestFor(
  deps: RunDeps,
  input: {
    runId: string;
    source: RunRequest["source"];
    command: string;
    timeoutSeconds: number;
    ready: import("./environments").Environment;
    requires?: RunRequest["requires"];
    target?: RunRequest["target"];
    releaseAfterRun: boolean;
  },
) {
  const { runId, source, command, timeoutSeconds, ready } = input;
  const expiry = (seconds: number) => runUrlLifetime(ready.deadline_at!, seconds);
  for (const reference of [source.base.bundle, source.head.bundle, source.overlay]) {
    if (reference) reference.url = await deps.storage.signedUrl("GET", reference.url, expiry(1800));
  }
  const request: RunRequest = {
    type: "pocketcoder.remote-test/v2",
    runId,
    releaseAfterRun: input.releaseAfterRun,
    source,
    command,
    timeoutSeconds,
    deadlineAt: ready.deadline_at!,
    requires:
      input.requires ?? (/\btest:review\b/.test(command) ? ["git-history", "docker", "browsers"] : ["git-history"]),
    ...(input.target ? { target: input.target } : {}),
    runtime: { template: `${ready.template.name}@${ready.template.version}`, image: "unknown", placement: "unknown" },
    log: {
      url: await deps.storage.signedUrl("PUT", `logs/${runId}.log`, expiry(timeoutSeconds + 1800)),
      checkpointUrl: await deps.storage.signedUrl(
        "PUT",
        `checkpoints/logs/${runId}.log`,
        expiry(timeoutSeconds + 1800),
      ),
    },
    results: {
      url: await deps.storage.signedUrl("PUT", `results/${runId}.tar.gz`, expiry(timeoutSeconds + 1800)),
      checkpointUrl: await deps.storage.signedUrl(
        "PUT",
        `checkpoints/results/${runId}.tar.gz`,
        expiry(timeoutSeconds + 1800),
      ),
      paths: ["test-results", "*/test-results", "*/*/test-results"],
      ...(/\btest:review\b/.test(command)
        ? {
            temporaryPaths: [
              "*/checks.json",
              "*/source/test-results",
              "*/source/*/test-results",
              "*/source/*/*/test-results",
            ],
          }
        : {}),
      maxBytes: 2 * 1024 ** 3,
    },
  };
  return request;
}
