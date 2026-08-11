import { type AgentApiEvent, readAgentApiEvents } from "./agentapi-events";
import {
  type AgentApiMessage,
  changesUrlFor,
  delay,
  isAgentMessage,
  parseMessages,
} from "./client-helpers";
import {
  RemoteRequestError,
  type RemoteRequestPhase,
  remoteResponseError,
} from "./remote-request-error";

export type { AgentApiMessage } from "./client-helpers";

export interface RemoteAgentClientConfig {
  serviceUrl: string;
  key: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface AgentApiStatus {
  status?: string;
}

interface WorkspaceChange {
  cursor?: unknown;
  workspace?: {
    agent_state?: unknown;
  };
}

type FetchLike = typeof fetch;
type SnapshotCallback = (snapshot: string) => void;
type AcceptedCallback = () => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class RemoteAgentClient {
  readonly serviceUrl: string;
  readonly key: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly fetchImpl: FetchLike;
  private changesUrl: string | undefined;

  constructor(config: RemoteAgentClientConfig, fetchImpl: FetchLike = fetch) {
    this.serviceUrl = config.serviceUrl.replace(/\/$/, "");
    this.key = config.key;
    this.pollIntervalMs = config.pollIntervalMs ?? 250;
    this.timeoutMs = config.timeoutMs ?? 600_000;
    this.fetchImpl = fetchImpl;
    this.changesUrl = changesUrlFor(this.serviceUrl);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return await this.fetchImpl(`${this.serviceUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  }

  private async messages(
    phase: RemoteRequestPhase,
    promptAccepted: boolean,
    signal?: AbortSignal,
  ): Promise<AgentApiMessage[]> {
    const response = await this.request("/messages", { signal });
    if (!response.ok) throw await remoteResponseError(response, phase, promptAccepted);
    return parseMessages(await response.json());
  }

  private async status(
    phase: RemoteRequestPhase,
    promptAccepted: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.request("/status", { signal });
    if (!response.ok) throw await remoteResponseError(response, phase, promptAccepted);
    const body = (await response.json()) as AgentApiStatus;
    if (body.status !== "running" && body.status !== "stable") {
      throw new Error(`AgentAPI returned an unknown status: ${JSON.stringify(body.status)}`);
    }
    return body.status;
  }

  private async eventStream(
    phase: RemoteRequestPhase,
    promptAccepted: boolean,
    signal: AbortSignal,
  ): Promise<Response | null> {
    const response = await this.request("/events", {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if ([404, 409, 422].includes(response.status)) return null;
    if (!response.ok) throw await remoteResponseError(response, phase, promptAccepted);
    if (!response.body) throw new Error("AgentAPI events response had no body");
    return response;
  }

  private async workspaceChange(
    after: number,
    waitSeconds: number,
    phase: RemoteRequestPhase,
    promptAccepted: boolean,
    signal?: AbortSignal,
  ): Promise<{ cursor: number; agentState: string } | undefined> {
    if (!this.changesUrl) return undefined;
    const url = new URL(this.changesUrl);
    url.searchParams.set("after", String(after));
    url.searchParams.set("wait", String(waitSeconds));
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${this.key}` },
      signal,
    });
    if (response.status === 404) {
      this.changesUrl = undefined;
      return undefined;
    }
    if (!response.ok) throw await remoteResponseError(response, phase, promptAccepted);
    const body = (await response.json()) as WorkspaceChange;
    if (
      typeof body.cursor !== "number" ||
      !isRecord(body.workspace) ||
      (body.workspace.agent_state !== "unknown" &&
        body.workspace.agent_state !== "running" &&
        body.workspace.agent_state !== "stable")
    ) {
      throw new Error("PocketCoder changes response was malformed");
    }
    return { cursor: body.cursor, agentState: body.workspace.agent_state };
  }

  private async submit(
    prompt: string,
    attachmentIds: string[],
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.request("/message", {
      method: "POST",
      body: JSON.stringify({
        content: prompt,
        type: "user",
        ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
      }),
      signal,
    });
    if (!response.ok) throw await remoteResponseError(response, "submit", false);
  }

  private async pollForReply(
    baselineId: number,
    changeCursor: number,
    deadline: number,
    signal: AbortSignal,
  ): Promise<string> {
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now();
      const change = await this.workspaceChange(
        changeCursor,
        Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000))),
        "reply_status",
        true,
        signal,
      );
      if (change) changeCursor = change.cursor;
      const [status, messages] = change
        ? [change.agentState, await this.messages("reply_messages", true, signal)]
        : await Promise.all([
            this.status("reply_status", true, signal),
            this.messages("reply_messages", true, signal),
          ]);
      const reply = messages
        .filter((message) => message.id > baselineId && isAgentMessage(message))
        .at(-1);
      if (status === "stable" && reply?.content.trim()) return reply.content;
      if (!change) await delay(this.pollIntervalMs, signal);
    }
    throw new Error(`remote agent did not finish within ${this.timeoutMs}ms`);
  }

  private async consumeEvents(
    initial: Response,
    onEvent: (event: AgentApiEvent) => Promise<void>,
    promptAccepted: () => boolean,
    signal: AbortSignal,
  ): Promise<"fallback" | "aborted"> {
    let response = initial;
    while (!signal.aborted) {
      const read = await this.readEvents(response, onEvent, signal);
      if (read === "aborted") return "aborted";
      const next = await this.nextEventStream(promptAccepted, signal);
      if (next === "aborted") return "aborted";
      if (next === "retry") continue;
      if (!next) return "fallback";
      response = next;
    }
    return "aborted";
  }

  private async readEvents(
    response: Response,
    onEvent: (event: AgentApiEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<"ended" | "aborted"> {
    try {
      if (!response.body) throw new Error("AgentAPI events response had no body");
      for await (const event of readAgentApiEvents(response.body, signal)) await onEvent(event);
      return "ended";
    } catch (error) {
      if (error instanceof RemoteRequestError) throw error;
      return signal.aborted ? "aborted" : "ended";
    }
  }

  private async nextEventStream(
    promptAccepted: () => boolean,
    signal: AbortSignal,
  ): Promise<Response | null | "retry" | "aborted"> {
    while (!promptAccepted() && !signal.aborted) await delay(this.pollIntervalMs, signal);
    if (signal.aborted) return "aborted";
    await delay(this.pollIntervalMs, signal);
    try {
      return await this.eventStream("reply_events", true, signal);
    } catch (error) {
      if (error instanceof RemoteRequestError) throw error;
      return signal.aborted ? "aborted" : "retry";
    }
  }

  async send(
    prompt: string,
    signal?: AbortSignal,
    attachmentIds: string[] = [],
    onSnapshot?: SnapshotCallback,
    onAccepted?: AcceptedCallback,
  ): Promise<string> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new Error(`remote agent did not finish within ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const turnSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const stopEvents = new AbortController();
    const eventSignal = AbortSignal.any([turnSignal, stopEvents.signal]);
    try {
      const before = await this.messages("initial_messages", false, turnSignal);
      const baselineId = before.reduce((maximum, message) => Math.max(maximum, message.id), -1);
      const baselineChange = await this.workspaceChange(
        0,
        0,
        "baseline_changes",
        false,
        turnSignal,
      );
      const deadline = Date.now() + this.timeoutMs;
      const initialEvents = await this.eventStream("initial_events", false, eventSignal);
      if (!initialEvents) {
        await this.submit(prompt, attachmentIds, turnSignal);
        onAccepted?.();
        return await this.pollForReply(
          baselineId,
          baselineChange?.cursor ?? 0,
          deadline,
          turnSignal,
        );
      }

      let submitted = false;
      let lastSnapshot = "";
      let complete!: (value: string) => void;
      const completed = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const consume = this.consumeEvents(
        initialEvents,
        async (event) => {
          if (
            event.event === "message_update" &&
            event.data.id > baselineId &&
            (event.data.role === "agent" || event.data.role === "assistant") &&
            event.data.message.trim() &&
            event.data.message !== lastSnapshot
          ) {
            lastSnapshot = event.data.message;
            onSnapshot?.(lastSnapshot);
          }
          if (event.event !== "status_change" || event.data.status !== "stable" || !submitted) {
            return;
          }
          const final = (await this.messages("reply_messages", true, turnSignal))
            .filter((message) => message.id > baselineId && isAgentMessage(message))
            .at(-1);
          if (!final?.content.trim()) return;
          if (final.content !== lastSnapshot) onSnapshot?.(final.content);
          complete(final.content);
        },
        () => submitted,
        eventSignal,
      );
      await this.submit(prompt, attachmentIds, turnSignal);
      submitted = true;
      onAccepted?.();
      const outcome = await Promise.race([
        completed.then((value) => ({ kind: "complete" as const, value })),
        consume.then((result) => ({ kind: result })),
      ]);
      if (outcome.kind === "complete") return outcome.value;
      if (outcome.kind === "fallback") {
        return await this.pollForReply(
          baselineId,
          baselineChange?.cursor ?? 0,
          deadline,
          turnSignal,
        );
      }
      throw turnSignal.reason ?? new Error("remote request aborted");
    } catch (error) {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      stopEvents.abort("turn ended");
    }
  }
}

export { serviceUrlFromEnvironment } from "./environment";
