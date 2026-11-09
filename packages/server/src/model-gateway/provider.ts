import { ApiError, digestOf } from "@pstdio/pocketcoder-contracts";
import type { ModelGatewayConfig } from "./config";

// Trusted usage read from the provider's own terminal response on our authenticated connection.
export interface ProviderUsage {
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  evidenceRef: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function headers(config: ModelGatewayConfig) {
  // Only the standing provider key is sent. Workspace headers never cross this boundary.
  return { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" };
}

// Counts the exact frozen request at the provider. No local estimate replaces a missing count.
export async function countInputTokens(
  config: ModelGatewayConfig,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
) {
  let reply: Response;
  try {
    reply = await fetchImpl(`${config.upstreamUrl}/v1/responses/input_tokens`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("relay.upstream_error", "The provider could not count this request.");
  }
  const text = await reply.text().catch(() => "");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const count = isObject(parsed) ? tokens(parsed.input_tokens) : null;
  if (!reply.ok || count === null)
    throw new ApiError("relay.upstream_error", "The provider did not return a trustworthy input count.", {
      providerStatus: reply.status,
    });
  return { inputTokens: count, evidenceRef: `openai-input-tokens:${digestOf({ request: body, reply: parsed })}` };
}

// One upstream generation attempt. Callers must never retry it automatically: once sent, a
// second attempt could generate and bill again.
export function sendResponse(
  config: ModelGatewayConfig,
  body: Record<string, unknown>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
) {
  return fetchImpl(`${config.upstreamUrl}/v1/responses`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify(body),
    signal,
  });
}

// Reads usage from a terminal response object. A missing or malformed usage block is not zero.
export function responseUsage(response: unknown, expectedId?: string): ProviderUsage | null {
  if (!isObject(response) || typeof response.id !== "string" || !response.id) return null;
  if (expectedId && response.id !== expectedId) return null;
  const usage = response.usage;
  if (!isObject(usage)) return null;
  // Cached input stays in input_tokens and reasoning stays in output_tokens, so neither is added again.
  const inputTokens = tokens(usage.input_tokens);
  const outputTokens = tokens(usage.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return {
    responseId: response.id,
    inputTokens,
    outputTokens,
    evidenceRef: `openai-usage:${digestOf({ id: response.id, status: response.status ?? null, usage })}`,
  };
}

const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.failed"]);

// Watches a provider SSE stream for the response identity and its terminal usage.
export class ResponseStreamObserver {
  responseId: string | null = null;
  usage: ProviderUsage | null = null;
  ended = false;
  private buffer = "";
  private readonly decoder = new TextDecoder();

  constructor(private readonly onResponseId: (id: string) => void) {}

  push(chunk: Uint8Array) {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end = this.buffer.indexOf("\n\n");
    while (end >= 0) {
      this.event(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 2);
      end = this.buffer.indexOf("\n\n");
    }
  }

  private event(block: string) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isObject(event) || !isObject(event.response)) return;
    const id = event.response.id;
    if (typeof id === "string" && id && !this.responseId) {
      this.responseId = id;
      this.onResponseId(id);
    }
    if (typeof event.type === "string" && TERMINAL_EVENTS.has(event.type)) {
      this.ended = true;
      this.usage = responseUsage(event.response, this.responseId ?? undefined);
    }
  }
}
