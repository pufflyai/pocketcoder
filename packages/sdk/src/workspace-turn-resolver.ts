import type { WorkspaceResource, WorkspaceState } from "@pstdio/pocketcoder-contracts";
import type { PocketCoderClient } from "./client";

export type WorkspaceTurnResolutionErrorCode =
  | "not_resumable"
  | "resume_handler_missing"
  | "resume_failed"
  | "invalid_resumed_workspace"
  | "readiness_failed";

const ERROR_MESSAGES: Record<WorkspaceTurnResolutionErrorCode, string> = {
  not_resumable: "workspace cannot be resumed",
  resume_handler_missing: "workspace resume handler is not configured",
  resume_failed: "workspace resume failed",
  invalid_resumed_workspace: "workspace resume returned an invalid workspace",
  readiness_failed: "resumed workspace did not become ready",
};

export class WorkspaceTurnResolutionError extends Error {
  readonly code: WorkspaceTurnResolutionErrorCode;

  constructor(code: WorkspaceTurnResolutionErrorCode, cause?: unknown) {
    super(ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = "WorkspaceTurnResolutionError";
    this.code = code;
  }
}

export interface ResumeWorkspaceContext {
  source: WorkspaceResource;
  attemptId: string;
  signal: AbortSignal;
}

export interface WorkspaceTurnResolverOptions {
  client: PocketCoderClient;
  resumeWorkspace?: (context: ResumeWorkspaceContext) => Promise<WorkspaceResource>;
  resumeTimeoutMs?: number;
}

export interface ResolveWorkspaceTurnOptions {
  signal?: AbortSignal;
}

export interface ResolvedWorkspaceTurn {
  workspace: WorkspaceResource;
  resumed: boolean;
}

interface ActiveAttempt {
  controller: AbortController;
  promise: Promise<ResolvedWorkspaceTurn>;
  waiters: number;
  resumeStarted: boolean;
  settled: boolean;
}

const NON_RESUMABLE_STATES: ReadonlySet<WorkspaceState> = new Set([
  "failed",
  "canceled",
  "expired",
  "succeeded",
  "terminating",
]);

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function waitForCaller<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(aborted(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function requireRemaining(deadline: number, failure: WorkspaceTurnResolutionErrorCode): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new WorkspaceTurnResolutionError(failure);
  return remaining;
}

export class WorkspaceTurnResolver {
  private readonly client: PocketCoderClient;
  private readonly resumeWorkspace: WorkspaceTurnResolverOptions["resumeWorkspace"];
  private readonly resumeTimeoutMs: number;
  private readonly attempts = new Map<string, ActiveAttempt>();

  constructor(options: WorkspaceTurnResolverOptions) {
    this.client = options.client;
    this.resumeWorkspace = options.resumeWorkspace;
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? 300_000;
  }

  async resolve(
    sourceWorkspaceId: string,
    options: ResolveWorkspaceTurnOptions = {},
  ): Promise<ResolvedWorkspaceTurn> {
    if (options.signal?.aborted) throw aborted(options.signal);
    const attempt = this.attempts.get(sourceWorkspaceId) ?? this.start(sourceWorkspaceId);
    attempt.waiters += 1;
    try {
      return await waitForCaller(attempt.promise, options.signal);
    } finally {
      attempt.waiters -= 1;
      if (attempt.waiters === 0 && !attempt.resumeStarted && !attempt.settled) {
        attempt.controller.abort(new DOMException("No callers remain", "AbortError"));
      }
    }
  }

  private start(sourceWorkspaceId: string): ActiveAttempt {
    const attempt: ActiveAttempt = {
      controller: new AbortController(),
      promise: Promise.resolve(undefined as never),
      waiters: 0,
      resumeStarted: false,
      settled: false,
    };
    this.attempts.set(sourceWorkspaceId, attempt);
    attempt.promise = this.run(sourceWorkspaceId, attempt).finally(() => {
      attempt.settled = true;
      if (this.attempts.get(sourceWorkspaceId) === attempt) {
        this.attempts.delete(sourceWorkspaceId);
      }
    });
    void attempt.promise.catch(() => {});
    return attempt;
  }

  private async run(
    sourceWorkspaceId: string,
    attempt: ActiveAttempt,
  ): Promise<ResolvedWorkspaceTurn> {
    const deadline = Date.now() + this.resumeTimeoutMs;
    let source = await this.client.workspaces.get(sourceWorkspaceId, {
      signal: attempt.controller.signal,
    });
    if (source.state === "ready") return { workspace: source, resumed: false };
    if (source.state === "preserving") {
      source = await this.waitForPreserved(source, deadline, attempt.controller.signal);
    }
    this.assertResumable(source);
    if (!this.resumeWorkspace) {
      throw new WorkspaceTurnResolutionError("resume_handler_missing");
    }

    attempt.resumeStarted = true;
    const attemptId = crypto.randomUUID();
    let allocated: WorkspaceResource;
    try {
      allocated = await this.resumeWorkspace({
        source,
        attemptId,
        signal: attempt.controller.signal,
      });
    } catch (error) {
      throw new WorkspaceTurnResolutionError("resume_failed", error);
    }

    let fetched: WorkspaceResource;
    try {
      fetched = await this.client.workspaces.get(allocated.id, {
        signal: attempt.controller.signal,
      });
    } catch (error) {
      throw new WorkspaceTurnResolutionError("invalid_resumed_workspace", error);
    }
    this.assertLineage(source, fetched);

    try {
      const workspace = await this.client.workspaces.waitForReady(
        fetched,
        requireRemaining(deadline, "readiness_failed"),
        { signal: attempt.controller.signal },
      );
      return { workspace, resumed: true };
    } catch (error) {
      if (error instanceof WorkspaceTurnResolutionError) throw error;
      throw new WorkspaceTurnResolutionError("readiness_failed", error);
    }
  }

  private async waitForPreserved(
    initial: WorkspaceResource,
    deadline: number,
    signal: AbortSignal,
  ): Promise<WorkspaceResource> {
    let workspace = initial;
    while (workspace.state === "preserving") {
      const remaining = requireRemaining(deadline, "resume_failed");
      try {
        const change = await this.client.workspaces.change(
          workspace.id,
          workspace.change_cursor,
          Math.max(1, Math.min(30, Math.ceil(remaining / 1_000))),
          { signal },
        );
        workspace = change.workspace;
      } catch (error) {
        if (signal.aborted) throw error;
        throw new WorkspaceTurnResolutionError("resume_failed", error);
      }
    }
    if (workspace.state === "failed") {
      throw new WorkspaceTurnResolutionError("resume_failed");
    }
    return workspace;
  }

  private assertResumable(workspace: WorkspaceResource): void {
    if (
      workspace.state !== "preserved" ||
      NON_RESUMABLE_STATES.has(workspace.state) ||
      workspace.persistence.conversation_resume.status !== "supported" ||
      !workspace.persistence.latest_checkpoint_id
    ) {
      throw new WorkspaceTurnResolutionError("not_resumable");
    }
  }

  private assertLineage(source: WorkspaceResource, resumedWorkspace: WorkspaceResource): void {
    if (
      resumedWorkspace.id === source.id ||
      resumedWorkspace.origin_workspace_id !== source.id ||
      resumedWorkspace.restored_from_checkpoint_id !== source.persistence.latest_checkpoint_id
    ) {
      throw new WorkspaceTurnResolutionError("invalid_resumed_workspace");
    }
  }
}
