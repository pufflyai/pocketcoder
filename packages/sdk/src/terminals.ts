import {
  type ServerTerminalMessage,
  ServerTerminalMessageSchema,
  TERMINAL_CHUNK_BYTES,
  type TerminalSession,
  TerminalSessionPageSchema,
} from "@pstdio/pocketcoder-contracts";
import { page, queryString } from "./common";
import type { PocketCoderTransport, RequestOptions } from "./transport";

export interface TerminalConnectOptions {
  sessionId?: string;
}

export class TerminalConnection {
  private readonly messageListeners = new Set<(message: ServerTerminalMessage) => void>();
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(event: CloseEvent) => void>();
  private readonly errorListeners = new Set<() => void>();
  private readonly pendingMessages: ServerTerminalMessage[] = [];
  private opened = false;
  private closedEvent: CloseEvent | null = null;
  private errored = false;

  constructor(readonly socket: WebSocket) {
    this.opened = socket.readyState === WebSocket.OPEN;
    socket.addEventListener("open", () => {
      this.opened = true;
      for (const listener of this.openListeners) listener();
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", (event) => {
      this.closedEvent = event;
      for (const listener of this.closeListeners) listener(event);
    });
    socket.addEventListener("error", () => {
      this.errored = true;
      for (const listener of this.errorListeners) listener();
    });
  }

  onMessage(listener: (message: ServerTerminalMessage) => void): () => void {
    this.messageListeners.add(listener);
    for (const message of this.pendingMessages.splice(0)) listener(message);
    return () => this.messageListeners.delete(listener);
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    if (this.opened) queueMicrotask(() => this.openListeners.has(listener) && listener());
    return () => this.openListeners.delete(listener);
  }

  onClose(listener: (event: CloseEvent) => void): () => void {
    this.closeListeners.add(listener);
    if (this.closedEvent) {
      const event = this.closedEvent;
      queueMicrotask(() => this.closeListeners.has(listener) && listener(event));
    }
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    if (this.errored) queueMicrotask(() => this.errorListeners.has(listener) && listener());
    return () => this.errorListeners.delete(listener);
  }

  sendInput(value: Uint8Array | string): void {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_CHUNK_BYTES) {
      this.socket.send(
        JSON.stringify({
          type: "input",
          data_b64: Buffer.from(bytes.subarray(offset, offset + TERMINAL_CHUNK_BYTES)).toString(
            "base64",
          ),
        }),
      );
    }
  }

  resize(rows: number, cols: number): void {
    this.socket.send(JSON.stringify({ type: "resize", rows, cols }));
  }

  close(code = 1000, reason = "client detached"): void {
    this.socket.close(code, reason);
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = ServerTerminalMessageSchema.safeParse(value);
    if (!parsed.success) return;
    if (this.messageListeners.size === 0) {
      this.pendingMessages.push(parsed.data);
      return;
    }
    for (const listener of this.messageListeners) listener(parsed.data);
  }
}

export class TerminalsApi {
  constructor(private readonly transport: PocketCoderTransport) {}

  connect(workspaceId: string, options: TerminalConnectOptions = {}): TerminalConnection {
    const query = options.sessionId ? `?${queryString({ session: options.sessionId })}` : "";
    const socket = this.transport.webSocket(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/terminal${query}`,
    );
    return new TerminalConnection(socket);
  }

  async list(
    workspaceId: string,
    query: { cursor?: string; limit?: number } = {},
    options: RequestOptions = {},
  ): Promise<{ items: TerminalSession[]; nextCursor: string | null }> {
    const body = await this.transport.request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/terminal-sessions?${queryString({ cursor: query.cursor, limit: query.limit ?? 50 })}`,
      TerminalSessionPageSchema,
      options,
    );
    return page(body);
  }
}
