import { randomUUID } from "node:crypto";
import { ApiError, digestOf, errorEnvelope } from "@pstdio/pocketcoder-contracts";
import type { ModelGatewayConfig } from "./config";
import {
  GATEWAY_TURN_HEADER,
  type GatewayBudgets,
  type GatewayGrant,
  type GatewayInvocation,
  type ManagedInvocationIdentity,
  type ManagedRequestIdentity,
  type ResolveGrant,
} from "./grant";
import { countInputTokens, ResponseStreamObserver, responseUsage, sendResponse } from "./provider";
import { type GatewayRequest, gatewayRequest } from "./request-policy";

export interface ModelGatewayDeps {
  budgets: GatewayBudgets;
  resolveGrant: ResolveGrant;
  onBudgetDenied?(identity: ManagedRequestIdentity): Promise<void>;
  // Store failures while settling a call that already returned to the client.
  onError?(error: unknown): void;
  config: ModelGatewayConfig;
  fetch?: typeof fetch;
  now?: () => Date;
}

function errorResponse(error: unknown) {
  // Only our own safe messages leave the gateway. Provider bodies and stack traces never do.
  const api = error instanceof ApiError ? error : new ApiError("internal.error", "The model gateway failed.");
  return Response.json(errorEnvelope(api.code, api.message, randomUUID(), api.details), { status: api.status });
}

async function boundedJson(request: Request, maxBytes: number) {
  const tooLarge = () => new ApiError("request.body_too_large", "The model request is too large.");
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError("validation.invalid", "The request body must be a JSON object.");
  }
}

function bearerOf(request: Request) {
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match?.[1]) throw new ApiError("auth.invalid_key", "A workspace gateway credential is required.");
  return match[1];
}

export function createModelGateway(deps: ModelGatewayDeps) {
  const { budgets, config } = deps;
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  let active = 0;

  async function denied(error: unknown, identity: ManagedRequestIdentity) {
    if (error instanceof ApiError && error.code === "budget.exhausted") await deps.onBudgetDenied?.(identity);
  }

  // After a send claim the outcome is unknown until trusted usage arrives. The hold stays.
  async function uncertain(identity: ManagedInvocationIdentity) {
    await budgets.retainUncertain(identity).catch((error: unknown) => deps.onError?.(error));
  }

  async function settle(identity: ManagedInvocationIdentity, usage: ReturnType<typeof responseUsage>) {
    if (!usage) return uncertain(identity);
    try {
      await budgets.settle({
        provider: config.provider,
        providerAccountId: config.providerAccountId,
        responseId: usage.responseId,
        identity,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        providerEvidenceRef: usage.evidenceRef,
        observedAt: now(),
      });
    } catch (error) {
      deps.onError?.(error);
      await uncertain(identity);
    }
  }

  async function admit(grant: GatewayGrant, parsed: GatewayRequest) {
    const count = await countInputTokens(config, parsed.count, fetchImpl);
    const identity = { ...grant.identity, invocationId: randomUUID() };
    const input: GatewayInvocation = {
      requestDigest: digestOf({ frozen: parsed.frozen, requestedOutputTokens: parsed.requestedOutputTokens }),
      countEvidenceRef: count.evidenceRef,
      identity,
      workspaceId: grant.workspaceId,
      model: parsed.logicalModel,
      inputTokens: count.inputTokens,
      requestedOutputTokens: parsed.requestedOutputTokens,
    };
    const reservation = await budgets.reserve(input).catch(async (error: unknown) => {
      await denied(error, grant.identity);
      throw error;
    });
    const cap = reservation.reservation.outputTokenCap;
    // A cap below the qualified minimum is refused. It is never rounded up past the admitted allowance.
    if (cap < parsed.minOutputTokens) {
      await budgets.abandonUnsent(identity);
      throw new ApiError("relay.route_not_allowed", "The remaining output allowance is below the model minimum.");
    }
    const claimed = await budgets.claimSend(identity).catch(async (error: unknown) => {
      await budgets.abandonUnsent(identity).catch((cause: unknown) => deps.onError?.(cause));
      await denied(error, grant.identity);
      throw error;
    });
    if (!claimed) throw new ApiError("operation.conflict", "This model call can no longer be sent.");
    return { identity, payload: { ...parsed.frozen, max_output_tokens: cap } };
  }

  // Draining continues after the client leaves, so usage can still settle, but only for a bounded time.
  function drainBound(request: Request, upstream: AbortController) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      timer = setTimeout(() => upstream.abort(), config.drainTimeoutMs);
    };
    if (request.signal.aborted) start();
    else request.signal.addEventListener("abort", start, { once: true });
    return () => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", start);
    };
  }

  // The response ID is kept as soon as it is seen, and before the outcome is decided.
  function recordResponse(identity: ManagedInvocationIdentity, responseId: unknown) {
    if (typeof responseId !== "string" || !responseId) return Promise.resolve();
    return budgets.observeResponse(identity, responseId).catch((error: unknown) => deps.onError?.(error));
  }

  async function observeStream(body: ReadableStream<Uint8Array>, identity: ManagedInvocationIdentity) {
    let recorded = Promise.resolve();
    const observer = new ResponseStreamObserver((responseId) => {
      recorded = recordResponse(identity, responseId);
    });
    try {
      for await (const chunk of body) observer.push(chunk);
    } catch {
      // A dropped stream leaves the usage unknown, never zero.
    }
    await recorded;
    await settle(identity, observer.usage);
  }

  async function forward(request: Request, identity: ManagedInvocationIdentity, payload: Record<string, unknown>) {
    const upstream = new AbortController();
    const release = drainBound(request, upstream);
    let reply: Response;
    try {
      reply = await sendResponse(config, payload, upstream.signal, fetchImpl);
    } catch {
      release();
      await uncertain(identity);
      throw new ApiError("relay.upstream_error", "The provider call did not complete.");
    }
    if (!reply.ok || !reply.body) {
      await reply.body?.cancel().catch(() => {});
      release();
      await uncertain(identity);
      throw new ApiError("relay.upstream_error", "The provider rejected the model call.", {
        providerStatus: reply.status,
      });
    }
    if (payload.stream !== true) {
      const text = await reply.text().catch(() => null);
      release();
      let parsed: unknown = null;
      try {
        parsed = text === null ? null : JSON.parse(text);
      } catch {}
      if (parsed && typeof parsed === "object") await recordResponse(identity, (parsed as { id?: unknown }).id);
      await settle(identity, responseUsage(parsed));
      if (text === null) throw new ApiError("relay.upstream_error", "The provider reply was interrupted.");
      return { response: new Response(text, { headers: { "content-type": "application/json" } }), done: null };
    }
    const [client, watched] = reply.body.tee();
    const done = observeStream(watched, identity).finally(release);
    const response = new Response(client, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
    return { response, done };
  }

  async function call(request: Request) {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/v1/responses"))
      throw new ApiError("relay.route_not_allowed", "Only the Responses route is supported.");
    const grant = await deps.resolveGrant(bearerOf(request), request.headers.get(GATEWAY_TURN_HEADER));
    if (active >= config.maxConcurrentCalls)
      throw new ApiError("capacity.queue_full", "The model gateway is busy. Retry later.");
    active++;
    let done: Promise<void> | null = null;
    try {
      const parsed = gatewayRequest(await boundedJson(request, config.maxRequestBytes), grant.allowedModels, config);
      const { identity, payload } = await admit(grant, parsed);
      const result = await forward(request, identity, payload);
      done = result.done;
      return result.response;
    } finally {
      if (done) done.finally(() => active--);
      else active--;
    }
  }

  return (request: Request) => call(request).catch(errorResponse);
}
