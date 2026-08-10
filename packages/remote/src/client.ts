import { type AgentApiEvent, readAgentApiEvents } from "./agentapi-events";

export interface AgentApiMessage {
  id: number;
  content: string;
  role: string;
}

export interface RemoteAgentClientConfig {
  serviceUrl: string;
  key: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface AgentApiStatus {
  status?: string;
}

interface AgentApiMessages {
  messages?: unknown;
}

interface WorkspaceChange {
  cursor?: unknown;
  workspace?: {
    agent_state?: unknown;
  };
}

type FetchLike = typeof fetch;
type SnapshotCallback = (snapshot: string) => void;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new Error("remote request aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMessages(value: unknown): AgentApiMessage[] {
  const items = isRecord(value) && Array.isArray(value.messages) ? value.messages : [];
  return items.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "number" ||
      typeof item.content !== "string" ||
      typeof item.role !== "string"
    ) {
      return [];
    }
    return [{ id: item.id, content: item.content, role: item.role }];
  });
}

function isAgentMessage(message: AgentApiMessage): boolean {
  return message.role === "agent" || message.role === "assistant";
}

function changesUrlFor(serviceUrl: string): string | undefined {
  const url = new URL(serviceUrl);
  const match = url.pathname.match(/^(.*\/v1\/workspaces\/[^/]+)\/(?:agent|services\/agent)$/);
  if (!match) return undefined;
  url.pathname = `${match[1]}/changes`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.text()).trim();
  return body ? `${response.status} ${body.slice(0, 1000)}` : String(response.status);
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

  private async messages(signal?: AbortSignal): Promise<AgentApiMessage[]> {
    const response = await this.request("/messages", { signal });
    if (!response.ok) {
      throw new Error(`AgentAPI messages request failed: ${await responseError(response)}`);
    }
    return parseMessages((await response.json()) as AgentApiMessages);
  }

  private async status(signal?: AbortSignal): Promise<string> {
    const response = await this.request("/status", { signal });
    if (!response.ok) {
      throw new Error(`AgentAPI status request failed: ${await responseError(response)}`);
    }
    const body = (await response.json()) as AgentApiStatus;
    if (body.status !== "running" && body.status !== "stable") {
      throw new Error(`AgentAPI returned an unknown status: ${JSON.stringify(body.status)}`);
    }
    return body.status;
  }

  private async eventStream(signal: AbortSignal): Promise<Response | null> {
    const response = await this.request("/events", {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if ([404, 409, 422].includes(response.status)) return null;
    if (!response.ok) {
      throw new Error(`AgentAPI events request failed: ${await responseError(response)}`);
    }
    if (!response.body) throw new Error("AgentAPI events response had no body");
    return response;
  }

  private async workspaceChange(
    after: number,
    waitSeconds: number,
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
    if (!response.ok) {
      throw new Error(`PocketCoder changes request failed: ${await responseError(response)}`);
    }
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
    if (!response.ok) {
      throw new Error(`AgentAPI message request failed: ${await responseError(response)}`);
    }
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
        signal,
      );
      if (change) changeCursor = change.cursor;
      const [status, messages] = change
        ? [change.agentState, await this.messages(signal)]
        : await Promise.all([this.status(signal), this.messages(signal)]);
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
    signal: AbortSignal,
  ): Promise<"fallback" | "aborted"> {
    let response = initial;
    while (!signal.aborted) {
      try {
        if (!response.body) throw new Error("AgentAPI events response had no body");
        for await (const event of readAgentApiEvents(response.body, signal)) {
          await onEvent(event);
        }
      } catch {
        if (signal.aborted) return "aborted";
      }
      if (signal.aborted) return "aborted";
      await delay(this.pollIntervalMs, signal);
      try {
        const reconnected = await this.eventStream(signal);
        if (!reconnected) return "fallback";
        response = reconnected;
      } catch {
        if (signal.aborted) return "aborted";
      }
    }
    return "aborted";
  }

  async send(
    prompt: string,
    signal?: AbortSignal,
    attachmentIds: string[] = [],
    onSnapshot?: SnapshotCallback,
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
      const before = await this.messages(turnSignal);
      const baselineId = before.reduce((maximum, message) => Math.max(maximum, message.id), -1);
      const baselineChange = await this.workspaceChange(0, 0, turnSignal);
      const deadline = Date.now() + this.timeoutMs;
      const initialEvents = await this.eventStream(eventSignal);
      if (!initialEvents) {
        await this.submit(prompt, attachmentIds, turnSignal);
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
          const final = (await this.messages(turnSignal))
            .filter((message) => message.id > baselineId && isAgentMessage(message))
            .at(-1);
          if (!final?.content.trim()) return;
          if (final.content !== lastSnapshot) onSnapshot?.(final.content);
          complete(final.content);
        },
        eventSignal,
      );
      submitted = true;
      await this.submit(prompt, attachmentIds, turnSignal);
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
