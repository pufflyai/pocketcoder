import type { ConversationRequestIdentity } from "@pstdio/pocketcoder-sdk";
import { type AgentApiEvent, readAgentApiEvents } from "../stream/agentapi-events";
import {
  type AgentApiMessage,
  changesUrlFor,
  delay,
  isAgentMessage,
  parseMessages,
  parseWorkspaceChange,
} from "./client-helpers";
import { type IdentifiedTurnOptions, sendIdentifiedTurn } from "./identified-turn";
import { RemoteRequestError, type RemoteRequestPhase, remoteResponseError } from "./remote-request-error";

export type { AgentApiMessage } from "./client-helpers";

export interface RemoteAgentClientConfig {
  serviceUrl: string;
  key: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  // How long to wait for the agent to be ready for input before giving up.
  readyTimeoutMs?: number;
  // Runs when the caller aborts after the prompt may have reached the agent,
  // so the caller can stop the remote turn instead of leaving it running.
  onAbortAfterSend?: () => Promise<void>;
}

interface AgentApiStatus {
  status?: string;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SnapshotCallback = (snapshot: string) => void;
type AcceptedCallback = () => void;

export class RemoteAgentClient {
  readonly serviceUrl: string;
  readonly key: string;
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly readyTimeoutMs: number;
  readonly fetchImpl: FetchLike;
  private readonly onAbortAfterSend: (() => Promise<void>) | undefined;
  private changesUrl: string | undefined;

  constructor(config: RemoteAgentClientConfig, fetchImpl: FetchLike = fetch) {
    this.serviceUrl = config.serviceUrl.replace(/\/$/, "");
    this.key = config.key;
    this.pollIntervalMs = config.pollIntervalMs ?? 250;
    this.timeoutMs = config.timeoutMs ?? 600_000;
    // Waiting for input longer than the whole turn budget cannot help.
    this.readyTimeoutMs = Math.min(config.readyTimeoutMs ?? 120_000, this.timeoutMs);
    this.fetchImpl = fetchImpl;
    this.onAbortAfterSend = config.onAbortAfterSend;
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

  private async status(phase: RemoteRequestPhase, promptAccepted: boolean, signal?: AbortSignal): Promise<string> {
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
    return parseWorkspaceChange(await response.json());
  }

  // A workspace reports itself ready once its services answer health checks,
  // which can happen while AgentAPI is still starting. It rejects a user
  // message until it is waiting for input, so wait rather than fail the turn.
  private async waitForInput(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let cursor = 0;
    for (;;) {
      const remainingMs = deadline - Date.now();
      // Relay mode long-polls workspace changes; only a direct AgentAPI, which
      // has no changes endpoint, falls back to polling /status.
      const change = await this.workspaceChange(
        cursor,
        Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000))),
        "submit_readiness",
        false,
        signal,
      );
      const state = change ? change.agentState : await this.status("submit_readiness", false, signal);
      if (state === "stable") return;
      const advanced = change !== undefined && change.cursor !== cursor;
      if (change) cursor = change.cursor;
      if (Date.now() >= deadline) {
        throw new Error(`remote agent was still ${state} after ${this.readyTimeoutMs}ms and cannot accept a message`);
      }
      // Pace the loop whenever the long-poll returned without advancing, so a
      // stalled cursor cannot spin this into a hot loop.
      if (!advanced) await delay(this.pollIntervalMs, signal);
    }
  }

  private async submit(
    prompt: string,
    attachmentIds: string[],
    signal: AbortSignal,
    turn: { sending: boolean; timeout: AbortSignal },
  ): Promise<void> {
    await this.waitForInput(signal);
    turn.sending = true;
    // Finish sending even if the caller aborts: an interrupt that overtook
    // the prompt would find the agent idle and leave the new turn running.
    const response = await this.request("/message", {
      method: "POST",
      body: JSON.stringify({
        content: prompt,
        type: "user",
        ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
      }),
      signal: turn.timeout,
    });
    if (!response.ok) throw await remoteResponseError(response, "submit", false);
    signal.throwIfAborted();
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
        : await Promise.all([this.status("reply_status", true, signal), this.messages("reply_messages", true, signal)]);
      const reply = messages.filter((message) => message.id > baselineId && isAgentMessage(message)).at(-1);
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

  async sendTurn(prompt: string, identity: ConversationRequestIdentity, options: IdentifiedTurnOptions = {}) {
    return sendIdentifiedTurn(
      {
        request: (path, init) => this.request(path, init),
        waitForInput: (signal) => this.waitForInput(signal),
        timeoutMs: this.timeoutMs,
        pollIntervalMs: this.pollIntervalMs,
      },
      prompt,
      identity,
      options,
    );
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
    const turn = { sending: false, timeout: timeout.signal };
    try {
      const before = await this.messages("initial_messages", false, turnSignal);
      const baselineId = before.reduce((maximum, message) => Math.max(maximum, message.id), -1);
      const baselineChange = await this.workspaceChange(0, 0, "baseline_changes", false, turnSignal);
      const deadline = Date.now() + this.timeoutMs;
      const initialEvents = await this.eventStream("initial_events", false, eventSignal);
      if (!initialEvents) {
        await this.submit(prompt, attachmentIds, turnSignal, turn);
        onAccepted?.();
        return await this.pollForReply(baselineId, baselineChange?.cursor ?? 0, deadline, turnSignal);
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
      await this.submit(prompt, attachmentIds, turnSignal, turn);
      submitted = true;
      onAccepted?.();
      const outcome = await Promise.race([
        completed.then((value) => ({ kind: "complete" as const, value })),
        consume.then((result) => ({ kind: result })),
      ]);
      if (outcome.kind === "complete") return outcome.value;
      if (outcome.kind === "fallback") {
        return await this.pollForReply(baselineId, baselineChange?.cursor ?? 0, deadline, turnSignal);
      }
      throw turnSignal.reason ?? new Error("remote request aborted");
    } catch (error) {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (turn.sending && signal?.aborted) await this.onAbortAfterSend?.();
      throw error;
    } finally {
      clearTimeout(timer);
      stopEvents.abort("turn ended");
    }
  }
}

export { serviceUrlFromEnvironment } from "./environment";
