// Example-grade gateway: it authenticates one ephemeral bearer and forwards
// only bounded, text-only requests for one short-lived workspace session. A
// paid deployment still needs durable usage accounting and budget audit. See
// docs/security.md before modeling production on this file.
export interface OpenAIGatewayConfig {
  apiKey: string;
  clientBearer: string;
  allowedModel?: string;
  expiresAt?: Date;
  maxOutputTokens?: number;
  maxRequestBytes?: number;
  maxTotalRequestBytes?: number;
  maxRequests?: number;
  now?: () => Date;
  organization?: string;
  project?: string;
  upstreamUrl?: string;
  hostname?: string;
  port?: number;
}

type FetchLike = typeof fetch;

interface ParsedRequestBody {
  body: Record<string, unknown>;
  byteLength: number;
}

const ALLOWED_PATHS = new Set(["/v1/chat/completions", "/v1/responses"]);

function error(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

function hasNonTextInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasNonTextInput);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (
    typeof type === "string" &&
    ["image", "audio", "input_file"].some((kind) => type.includes(kind))
  ) {
    return true;
  }
  if (
    Array.isArray(record.modalities) &&
    record.modalities.some((modality) => modality !== "text")
  ) {
    return true;
  }
  return Object.values(record).some(hasNonTextInput);
}

function cappedBody(path: string, body: Record<string, unknown>, maxOutputTokens?: number) {
  if (!maxOutputTokens) return body;
  const field = path === "/v1/responses" ? "max_output_tokens" : "max_completion_tokens";
  const requested = body[field];
  return {
    ...body,
    [field]:
      typeof requested === "number" && Number.isFinite(requested)
        ? Math.min(requested, maxOutputTokens)
        : maxOutputTokens,
  };
}

function requestError(
  request: Request,
  path: string,
  config: OpenAIGatewayConfig,
  expired: boolean,
  requestCount: number,
) {
  if (request.method !== "POST" || !ALLOWED_PATHS.has(path)) {
    return new Response("not found", { status: 404 });
  }
  if (expired) return error(410, "gateway session expired");
  if (request.headers.get("authorization") !== `Bearer ${config.clientBearer}`) {
    return error(401, "unauthorized");
  }
  if (config.maxRequests !== undefined && requestCount >= config.maxRequests) {
    return error(429, "gateway session request limit reached");
  }
}

async function parseRequestBody(
  request: Request,
  config: OpenAIGatewayConfig,
  totalRequestBytes: number,
): Promise<ParsedRequestBody | Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (config.maxRequestBytes !== undefined && bytes.byteLength > config.maxRequestBytes) {
    return error(413, "request body is too large");
  }
  if (
    config.maxTotalRequestBytes !== undefined &&
    totalRequestBytes + bytes.byteLength > config.maxTotalRequestBytes
  ) {
    return error(429, "gateway session byte limit reached");
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return error(400, "request body must be a JSON object");
    }
    return { body: parsed as Record<string, unknown>, byteLength: bytes.byteLength };
  } catch {
    return error(400, "request body must be a JSON object");
  }
}

function bodyPolicyError(body: Record<string, unknown>, config: OpenAIGatewayConfig) {
  if (config.allowedModel && body.model !== config.allowedModel) {
    return error(403, "model is not allowed for this workspace");
  }
  if (hasNonTextInput(body)) {
    return error(403, "only text requests are allowed for this workspace");
  }
}

function isExpired(expiresAt: Date | undefined, currentTime: Date) {
  return expiresAt !== undefined && currentTime >= expiresAt;
}

export function createOpenAIGatewayHandler(
  config: OpenAIGatewayConfig,
  fetchImpl: FetchLike = fetch,
): (request: Request) => Promise<Response> {
  const upstreamUrl = (config.upstreamUrl ?? "https://api.openai.com").replace(/\/$/, "");
  const now = config.now ?? (() => new Date());
  let requestCount = 0;
  let totalRequestBytes = 0;

  return async (request) => {
    const url = new URL(request.url);
    const expired = isExpired(config.expiresAt, now());
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: !expired }, { status: expired ? 503 : 200 });
    }

    const sessionError = requestError(request, url.pathname, config, expired, requestCount);
    if (sessionError) return sessionError;
    const parsed = await parseRequestBody(request, config, totalRequestBytes);
    if (parsed instanceof Response) return parsed;
    const policyError = bodyPolicyError(parsed.body, config);
    if (policyError) return policyError;

    requestCount += 1;
    totalRequestBytes += parsed.byteLength;
    const forwardedBody = JSON.stringify(
      cappedBody(url.pathname, parsed.body, config.maxOutputTokens),
    );

    const headers = new Headers({
      authorization: `Bearer ${config.apiKey}`,
      "content-type": request.headers.get("content-type") ?? "application/json",
    });
    if (config.organization) headers.set("openai-organization", config.organization);
    if (config.project) headers.set("openai-project", config.project);

    const upstream = await fetchImpl(`${upstreamUrl}${url.pathname}`, {
      method: "POST",
      headers,
      body: forwardedBody,
      signal: request.signal,
    });
    const responseHeaders = new Headers(upstream.headers);
    for (const name of ["connection", "content-encoding", "content-length", "transfer-encoding"]) {
      responseHeaders.delete(name);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}

export function startOpenAIGateway(config: OpenAIGatewayConfig): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: config.hostname ?? "0.0.0.0",
    port: config.port ?? 0,
    fetch: createOpenAIGatewayHandler(config),
  });
}
