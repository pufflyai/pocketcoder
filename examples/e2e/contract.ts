import { randomUUID } from "node:crypto";
import {
  errorBody,
  messageError,
  messageId,
  messageList,
  observeLiveUpdates,
  readBody,
  responseText,
} from "./contract-messages";

const TERMINAL_STATES = new Set(["succeeded", "failed", "canceled", "expired"]);

export interface HarnessE2EConfig {
  baseUrl: string;
  key: string;
  template: string;
  templateVersion?: string;
  prompt: string;
  expectedResponse?: string;
  expectedConversation?: Array<{ role: string; content: string }>;
  readyTimeoutMs?: number;
  messageTimeoutMs?: number;
  pollIntervalMs?: number;
  expectedLiveUpdates?: number;
}

export interface HarnessWorkspaceConfig {
  baseUrl: string;
  key: string;
  template: string;
  templateVersion?: string;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ReadyHarnessWorkspace {
  workspaceId: string;
  template: string;
  readyInMs: number;
  request(path: string, init?: RequestInit): Promise<Response>;
  cancel(): Promise<string>;
}

export interface HarnessE2EReport {
  workspaceId: string;
  template: string;
  readyInMs: number;
  responseInMs: number;
  terminalState: string;
  responseText: string;
  durableConversationMessages: number | null;
  liveUpdates: number | null;
}

interface WorkspaceResource {
  id: string;
  state: string;
  reason_code?: string | null;
}

type FetchLike = typeof fetch;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs: number,
  pollIntervalMs: number,
  description: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await delay(pollIntervalMs);
  }
  throw new Error(`timed out waiting for ${description} after ${timeoutMs}ms`);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${description}`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function createHarnessWorkspace(
  config: HarnessWorkspaceConfig,
  fetchImpl: FetchLike = fetch,
): Promise<ReadyHarnessWorkspace> {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const readyTimeoutMs = config.readyTimeoutMs ?? 120_000;
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  const externalId = `example-${Date.now()}-${randomUUID()}`;
  const headers = {
    authorization: `Bearer ${config.key}`,
    "content-type": "application/json",
  };
  const request = async (path: string, init: RequestInit = {}): Promise<Response> =>
    await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });

  let workspaceId: string | null = null;
  try {
    const createResponse = await request("/v1/workspaces", {
      method: "POST",
      headers: { "idempotency-key": externalId },
      body: JSON.stringify({
        external_id: externalId,
        template: {
          name: config.template,
          ...(config.templateVersion ? { version: config.templateVersion } : {}),
        },
        launch_input: { example: "harness-e2e" },
        metadata: { source: "examples/e2e" },
      }),
    });
    const created = (await readBody(createResponse)) as WorkspaceResource;
    if (!createResponse.ok || typeof created?.id !== "string") {
      throw new Error(`workspace create failed (${createResponse.status}): ${errorBody(created)}`);
    }
    workspaceId = created.id;

    const readyStartedAt = Date.now();
    await waitFor(
      async () => {
        const response = await request(`/v1/workspaces/${workspaceId}`);
        const workspace = (await readBody(response)) as WorkspaceResource;
        if (!response.ok) {
          throw new Error(`workspace read failed (${response.status}): ${errorBody(workspace)}`);
        }
        if (workspace.state === "ready") return workspace;
        if (TERMINAL_STATES.has(workspace.state)) {
          throw new Error(
            `workspace reached ${workspace.state} (${workspace.reason_code ?? "no reason"}) before ready`,
          );
        }
        return null;
      },
      readyTimeoutMs,
      pollIntervalMs,
      "workspace readiness",
    );
    const readyInMs = Date.now() - readyStartedAt;
    const id = workspaceId;

    return {
      workspaceId: id,
      template: config.template,
      readyInMs,
      request,
      async cancel(): Promise<string> {
        const cancelResponse = await request(`/v1/workspaces/${id}/cancel`, {
          method: "POST",
        });
        if (!cancelResponse.ok) {
          throw new Error(
            `workspace cancel failed (${cancelResponse.status}): ${errorBody(await readBody(cancelResponse))}`,
          );
        }
        const terminal = await waitFor(
          async () => {
            const response = await request(`/v1/workspaces/${id}`);
            if (!response.ok) return null;
            const workspace = (await readBody(response)) as WorkspaceResource;
            return TERMINAL_STATES.has(workspace.state) ? workspace : null;
          },
          30_000,
          pollIntervalMs,
          "workspace cancellation",
        );
        return terminal.state;
      },
    };
  } catch (error) {
    if (workspaceId) {
      await request(`/v1/workspaces/${workspaceId}/cancel`, { method: "POST" }).catch(() => {});
    }
    throw error;
  }
}

export async function runHarnessE2E(
  config: HarnessE2EConfig,
  fetchImpl: FetchLike = fetch,
): Promise<HarnessE2EReport> {
  const messageTimeoutMs = config.messageTimeoutMs ?? 300_000;
  const pollIntervalMs = config.pollIntervalMs ?? 500;
  let workspace: ReadyHarnessWorkspace | null = null;
  let completed = false;
  try {
    workspace = await createHarnessWorkspace(
      {
        baseUrl: config.baseUrl,
        key: config.key,
        template: config.template,
        templateVersion: config.templateVersion,
        readyTimeoutMs: config.readyTimeoutMs,
        pollIntervalMs,
      },
      fetchImpl,
    );
    const { request, workspaceId, readyInMs } = workspace;

    const statusResponse = await request(`/v1/workspaces/${workspaceId}/agent/status`);
    if (!statusResponse.ok) {
      throw new Error(
        `status relay failed (${statusResponse.status}): ${errorBody(await readBody(statusResponse))}`,
      );
    }

    const beforeResponse = await request(`/v1/workspaces/${workspaceId}/agent/messages`);
    const before = beforeResponse.ok ? messageList(await readBody(beforeResponse)) : [];
    const baselineId = before.reduce(
      (maximum, message) => Math.max(maximum, messageId(message)),
      -1,
    );
    let liveUpdatesPromise: Promise<string[]> | null = null;
    let liveUpdatesController: AbortController | null = null;
    if (config.expectedLiveUpdates) {
      liveUpdatesController = new AbortController();
      const events = await request(`/v1/workspaces/${workspaceId}/agent/events`, {
        headers: { accept: "text/event-stream" },
        signal: liveUpdatesController.signal,
      });
      liveUpdatesPromise = observeLiveUpdates(events, baselineId);
    }

    const messageStartedAt = Date.now();
    const sendResponse = await request(`/v1/workspaces/${workspaceId}/agent/message`, {
      method: "POST",
      body: JSON.stringify({ content: config.prompt, type: "user" }),
    });
    if (!sendResponse.ok) {
      throw new Error(
        `message relay failed (${sendResponse.status}): ${errorBody(await readBody(sendResponse))}`,
      );
    }

    const observedText = await waitFor(
      async () => {
        const response = await request(`/v1/workspaces/${workspaceId}/agent/messages`);
        if (!response.ok) return null;
        const messages = messageList(await readBody(response));
        const harnessError = messages.slice(before.length).map(messageError).find(Boolean);
        if (harnessError) throw new Error(`harness reported an error: ${harnessError}`);
        const text = responseText(messages, before.length);
        if (config.expectedResponse) {
          return text.includes(config.expectedResponse) ? text : null;
        }
        return text || null;
      },
      messageTimeoutMs,
      pollIntervalMs,
      "harness response",
    );
    const responseInMs = Date.now() - messageStartedAt;
    let liveUpdates: number | null = null;
    if (liveUpdatesPromise) {
      let updates: string[];
      try {
        updates = await withTimeout(liveUpdatesPromise, messageTimeoutMs, "live AgentAPI updates");
      } finally {
        liveUpdatesController?.abort("turn stable");
      }
      liveUpdates = updates.length;
      if (updates.length < (config.expectedLiveUpdates ?? 0)) {
        throw new Error(
          `expected ${config.expectedLiveUpdates} live updates, observed ${updates.length}`,
        );
      }
    }

    let durableConversationMessages: number | null = null;
    if (config.expectedConversation) {
      const durable = await waitFor(
        async () => {
          const response = await request(`/v1/workspaces/${workspaceId}/conversation`);
          if (!response.ok) return null;
          const body = (await readBody(response)) as {
            items?: Array<{ role?: unknown; content?: unknown }>;
          };
          const items = body.items ?? [];
          const expected = config.expectedConversation ?? [];
          const matches = expected.every(
            (message, index) =>
              items[index]?.role === message.role && items[index]?.content === message.content,
          );
          return matches && items.length >= expected.length ? items : null;
        },
        messageTimeoutMs,
        pollIntervalMs,
        "durable conversation history",
      );
      durableConversationMessages = durable.length;
    }

    const terminalState = await workspace.cancel();
    if (terminalState !== "canceled") {
      throw new Error(`expected canceled workspace, got ${terminalState}`);
    }
    completed = true;
    return {
      workspaceId,
      template: config.template,
      readyInMs,
      responseInMs,
      terminalState,
      responseText: observedText,
      durableConversationMessages,
      liveUpdates,
    };
  } finally {
    if (workspace && !completed) {
      await workspace.cancel().catch(() => {});
    }
  }
}
