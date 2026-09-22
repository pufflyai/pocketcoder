import {
  OperationResourceSchema,
  type PreserveRequest,
  PreserveResponseSchema,
  type RestoreRequest,
  RestoreResponseSchema,
  ResumeResponseSchema,
  TERMINAL_STATES,
  WorkspaceChangeSchema,
  type WorkspaceCreateRequest,
  WorkspacePageSchema,
  type WorkspaceResource,
  WorkspaceResourceSchema,
  type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import { page, queryString } from "../../transport/common";
import { AgentNotReadyError, WorkspaceTerminalError } from "../../transport/errors";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";

export interface WorkspaceCreateInput {
  externalId: string;
  templateName: string;
  templateVersion?: string;
  idempotencyKey?: string;
  launchInput?: WorkspaceCreateRequest["launch_input"];
  metadata?: WorkspaceCreateRequest["metadata"];
  source?: WorkspaceCreateRequest["source"];
}

export interface WorkspaceListQuery {
  state?: WorkspaceState;
  template?: string;
  externalId?: string;
  limit?: number;
  cursor?: string;
}

export type WorkspaceSummary = WorkspaceResource;
export const TERMINAL_WORKSPACE_STATES: ReadonlySet<WorkspaceState> = new Set(TERMINAL_STATES);

export class WorkspacesApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  async list(query: WorkspaceListQuery = {}, options: RequestOptions = {}) {
    const body = await this.transport.request(
      `/v1/workspaces?${queryString({ state: query.state, template: query.template, external_id: query.externalId, limit: query.limit ?? 50, cursor: query.cursor })}`,
      WorkspacePageSchema,
      options,
    );
    return page(body);
  }

  async *all(query: Omit<WorkspaceListQuery, "cursor"> = {}, options: RequestOptions = {}) {
    let cursor: string | undefined;
    do {
      const current = await this.list({ ...query, cursor }, options);
      for (const workspace of current.items) yield workspace;
      cursor = current.nextCursor ?? undefined;
    } while (cursor);
  }

  get(id: string, options: RequestOptions = {}) {
    return this.transport.request(`/v1/workspaces/${encodeURIComponent(id)}`, WorkspaceResourceSchema, options);
  }

  create(input: WorkspaceCreateInput, options: RequestOptions = {}) {
    const body: WorkspaceCreateRequest = {
      external_id: input.externalId,
      template: {
        name: input.templateName,
        ...(input.templateVersion ? { version: input.templateVersion } : {}),
      },
      ...(input.launchInput ? { launch_input: input.launchInput } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.source ? { source: input.source } : {}),
    };
    return this.transport.request("/v1/workspaces", WorkspaceResourceSchema, {
      method: "POST",
      signal: options.signal,
      headers: { "Idempotency-Key": input.idempotencyKey ?? input.externalId },
      body: JSON.stringify(body),
    });
  }

  cancel(id: string, options: RequestOptions = {}) {
    return this.transport.request(`/v1/workspaces/${encodeURIComponent(id)}/cancel`, WorkspaceResourceSchema, {
      method: "POST",
      signal: options.signal,
    });
  }

  change(id: string, after: number, wait: number, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(id)}/changes?after=${after}&wait=${wait}`,
      WorkspaceChangeSchema,
      options,
    );
  }

  async waitForReady(
    initial: WorkspaceResource,
    timeoutMs: number,
    options: RequestOptions & { onTick?: (workspace: WorkspaceResource) => void } = {},
  ) {
    const deadline = Date.now() + timeoutMs;
    let workspace = initial;
    while (workspace.state !== "ready") {
      if (TERMINAL_STATES.includes(workspace.state)) throw new WorkspaceTerminalError(workspace);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`workspace ${workspace.id} did not become ready within ${timeoutMs}ms`);
      }
      const change = await this.change(
        workspace.id,
        workspace.change_cursor,
        Math.max(1, Math.min(30, Math.ceil(remainingMs / 1_000))),
        options,
      );
      workspace = change.workspace;
      options.onTick?.(workspace);
    }
    return workspace;
  }

  // A workspace turns ready when its services answer health checks, which can
  // happen while AgentAPI is still starting. Sending then is rejected upstream,
  // so callers must wait for the agent to be waiting for input.
  async waitForAgentInput(id: string, timeoutMs: number, options: RequestOptions = {}) {
    const deadline = Date.now() + timeoutMs;
    // Read the current state first: `change` blocks until the cursor moves, so
    // long-polling an already-stable agent would stall for no reason.
    let workspace = await this.get(id, options);
    while (workspace.agent_state !== "stable") {
      if (TERMINAL_STATES.includes(workspace.state)) throw new WorkspaceTerminalError(workspace);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new AgentNotReadyError(workspace.id, workspace.agent_state, timeoutMs);
      }
      const change = await this.change(
        workspace.id,
        workspace.change_cursor,
        Math.max(1, Math.min(30, Math.ceil(remainingMs / 1_000))),
        options,
      );
      workspace = change.workspace;
    }
    return workspace;
  }

  preserve(id: string, input: PreserveRequest, key: string, options: RequestOptions = {}) {
    return this.jsonOperation(
      `/v1/workspaces/${encodeURIComponent(id)}/preserve`,
      input,
      key,
      PreserveResponseSchema,
      options,
    );
  }

  purge(id: string, key: string, options: RequestOptions = {}) {
    return this.jsonOperation(
      `/v1/workspaces/${encodeURIComponent(id)}/purge`,
      {},
      key,
      OperationResourceSchema,
      options,
    );
  }

  recreate(id: string, input: RestoreRequest, key: string, options: RequestOptions = {}) {
    return this.jsonOperation(
      `/v1/workspaces/${encodeURIComponent(id)}/recreate`,
      input,
      key,
      RestoreResponseSchema,
      options,
    );
  }

  resume(id: string, input: RestoreRequest, key: string, options: RequestOptions = {}) {
    return this.jsonOperation(
      `/v1/workspaces/${encodeURIComponent(id)}/resume`,
      input,
      key,
      ResumeResponseSchema,
      options,
    );
  }

  private jsonOperation<T>(
    path: string,
    input: unknown,
    key: string,
    schema: import("zod").z.ZodType<T>,
    options: RequestOptions,
  ) {
    return this.transport.request(path, schema, {
      method: "POST",
      signal: options.signal,
      headers: { "Idempotency-Key": key },
      body: JSON.stringify(input),
    });
  }
}
