import { AgentInterruptResponseSchema } from "@pstdio/pocketcoder-contracts";
import { PocketCoderError, responseError } from "../../transport/errors";
import type { PocketCoderTransport, RequestOptions } from "../../transport/transport";
import type { WorkspacesApi } from "../workspaces/workspaces";

// Long enough for a cold coding agent to paint its prompt, short enough that a
// wedged workspace fails with a clear error instead of hanging.
const DEFAULT_READY_TIMEOUT_MS = 120_000;

export interface AgentMessageInput {
  content: string;
  attachmentIds?: string[];
  signal?: AbortSignal;
  // How long to wait for the agent to be ready for input before giving up.
  readyTimeoutMs?: number;
}

export class AgentApi {
  constructor(
    private readonly transport: PocketCoderTransport,
    private readonly workspaces: WorkspacesApi,
  ) {}

  // Sends an AgentAPI user message; resolves when the workspace accepted it.
  // The harness response body is service-specific and deliberately not modeled.
  async sendMessage(workspaceId: string, input: AgentMessageInput): Promise<void> {
    // AgentAPI rejects a user message unless it is waiting for input, and the
    // relay passes that rejection through as an opaque 500.
    await this.workspaces.waitForAgentInput(
      workspaceId,
      input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      input.signal ? { signal: input.signal } : {},
    );
    const response = await this.transport.raw(`/v1/workspaces/${encodeURIComponent(workspaceId)}/agent/message`, {
      method: "POST",
      ...(input.signal ? { signal: input.signal } : {}),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "user",
        content: input.content,
        ...(input.attachmentIds?.length ? { attachment_ids: input.attachmentIds } : {}),
      }),
    });
    if (response.ok) return;
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PocketCoderError({
        message: `PocketCoder returned a non-JSON response (${response.status})`,
        code: "client.non_json_response",
        status: response.status,
      });
    }
    throw responseError(response, body);
  }

  // Stops the agent's current turn and keeps the workspace and conversation.
  // `requested` means the keys were sent: wait for the agent to be stable.
  interrupt(workspaceId: string, options: RequestOptions = {}) {
    return this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/agent/interrupt`,
      AgentInterruptResponseSchema,
      { method: "POST", signal: options.signal },
    );
  }
}
