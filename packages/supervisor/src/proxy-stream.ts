import {
  type AgentFrame,
  PROXY_STREAM_CHUNK_BYTES,
  type ProxyRequest,
  type ProxyStreamAck,
  type ProxyStreamCancel,
  type TemplateService,
  type TemplateServiceRoute,
} from "@pstdio/pocketcoder-contracts";

type SendFrame = (type: AgentFrame["type"], payload: unknown) => boolean;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface BodyReader {
  read(): Promise<{ done: true; value?: undefined } | { done: false; value: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

interface AckWaiter {
  seq: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface ActiveStream {
  requestId: string;
  controller: AbortController;
  reader: BodyReader | null;
  ack: AckWaiter | null;
  timer: ReturnType<typeof setTimeout>;
  canceled: boolean;
  timedOut: boolean;
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cache-control"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function requestUrl(request: ProxyRequest, service: TemplateService): URL {
  const url = new URL(request.path, service.baseUrl);
  for (const [key, value] of Object.entries(request.query)) url.searchParams.set(key, value);
  return url;
}

export class ProxyStreamCoordinator {
  private readonly active = new Map<string, ActiveStream>();

  constructor(
    private readonly send: SendFrame,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  async relay(
    request: ProxyRequest,
    service: TemplateService,
    route: TemplateServiceRoute,
  ): Promise<void> {
    const controller = new AbortController();
    const stream: ActiveStream = {
      requestId: request.request_id,
      controller,
      reader: null,
      ack: null,
      timer: setTimeout(() => this.expire(request.request_id), request.deadline_ms),
      canceled: false,
      timedOut: false,
    };
    this.active.set(request.request_id, stream);
    try {
      const response = await this.fetchImpl(requestUrl(request, service), {
        method: request.method,
        headers: request.headers,
        ...(request.body_b64 ? { body: Buffer.from(request.body_b64, "base64") } : {}),
        signal: controller.signal,
      });
      if (stream.canceled) return;
      if (
        !this.send("proxy_stream_start", {
          request_id: request.request_id,
          status: response.status,
          headers: responseHeaders(response),
        })
      ) {
        stream.canceled = true;
        return;
      }
      const reader = response.body?.getReader();
      if (!reader) {
        this.send("proxy_stream_end", { request_id: request.request_id });
        return;
      }
      stream.reader = reader;
      if (!(await this.forwardBody(stream, reader, route.maxResponseBytes))) return;
      if (stream.timedOut) throw new Error("stream deadline exceeded");
      this.send("proxy_stream_end", { request_id: request.request_id });
    } catch {
      if (stream.canceled) return;
      this.send("proxy_stream_end", {
        request_id: request.request_id,
        error_code: stream.timedOut ? "deadline" : "unreachable",
      });
    } finally {
      clearTimeout(stream.timer);
      if (this.active.get(request.request_id) === stream) {
        this.active.delete(request.request_id);
      }
    }
  }

  private async forwardBody(
    stream: ActiveStream,
    reader: BodyReader,
    maxResponseBytes: number,
  ): Promise<boolean> {
    let seq = 0;
    let totalBytes = 0;
    while (true) {
      const next = await reader.read();
      if (stream.canceled) return false;
      if (stream.timedOut) throw new Error("stream deadline exceeded");
      if (next.done) return true;
      for (let offset = 0; offset < next.value.byteLength; offset += PROXY_STREAM_CHUNK_BYTES) {
        const chunk = next.value.subarray(offset, offset + PROXY_STREAM_CHUNK_BYTES);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxResponseBytes) {
          this.send("proxy_stream_end", {
            request_id: stream.requestId,
            error_code: "too_large",
          });
          stream.canceled = true;
          await reader.cancel("response too large").catch(() => {});
          return false;
        }
        await this.sendChunk(stream, seq, chunk);
        seq += 1;
      }
    }
  }

  handleAck(payload: ProxyStreamAck): void {
    const stream = this.active.get(payload.request_id);
    if (!stream?.ack || stream.ack.seq !== payload.seq) return;
    const ack = stream.ack;
    stream.ack = null;
    ack.resolve();
  }

  async handleCancel(payload: ProxyStreamCancel): Promise<void> {
    const stream = this.active.get(payload.request_id);
    if (!stream) return;
    stream.canceled = true;
    stream.controller.abort(payload.reason);
    stream.ack?.reject(new Error(`stream canceled: ${payload.reason}`));
    stream.ack = null;
    await stream.reader?.cancel(payload.reason).catch(() => {});
    this.active.delete(payload.request_id);
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.active.keys()].map((requestId) =>
        this.handleCancel({ request_id: requestId, reason: "workspace_disconnected" }),
      ),
    );
  }

  private async sendChunk(stream: ActiveStream, seq: number, chunk: Uint8Array): Promise<void> {
    const acknowledged = new Promise<void>((resolve, reject) => {
      stream.ack = { seq, resolve, reject };
    });
    if (
      !this.send("proxy_stream_chunk", {
        request_id: stream.requestId,
        seq,
        content_b64: Buffer.from(chunk).toString("base64"),
      })
    ) {
      stream.canceled = true;
      stream.ack = null;
      throw new Error("workspace connection closed");
    }
    await acknowledged;
  }

  private expire(requestId: string): void {
    const stream = this.active.get(requestId);
    if (!stream) return;
    stream.timedOut = true;
    stream.controller.abort("deadline");
    stream.ack?.reject(new Error("stream deadline exceeded"));
    stream.ack = null;
    void stream.reader?.cancel("deadline").catch(() => {});
  }
}
