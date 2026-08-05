import { ApiError, findRoute, isTerminal } from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Context } from "hono";
import type { Hub } from "./hub";
import type { AppEnv } from "./middleware";
import type { WorkspaceService } from "./service";

// The workspace service relay: exact template-declared loopback routes only.
// No arbitrary URL, port, path, header set, protocol upgrade, or TCP stream.

export interface RelayDeps {
	store: Store;
	hub: Hub;
	service: WorkspaceService;
}

const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control"];
type RelayMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type BufferedRelayResponse = Awaited<ReturnType<Hub["relay"]>>;
type RelayResponseHeaders = { headers: Record<string, string> };

function requestPath(c: Context<AppEnv>, prefix: string): string {
	const rawPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
	return rawPath === "" ? "/" : rawPath;
}

function allowedQuery(url: string, allowedFields: readonly string[]): Record<string, string> {
	const query: Record<string, string> = {};
	for (const [key, value] of new URL(url).searchParams) {
		if (!allowedFields.includes(key)) {
			throw new ApiError("relay.route_not_allowed", `Query field not allowed: ${key}.`);
		}
		query[key] = value;
	}
	return query;
}

async function requestBody(
	c: Context<AppEnv>,
	method: RelayMethod,
	maxBytes: number,
): Promise<string | undefined> {
	if (method === "GET") return undefined;
	const body = await c.req.arrayBuffer();
	if (body.byteLength > maxBytes) {
		throw new ApiError("relay.body_too_large", `Request body exceeds ${maxBytes} bytes.`);
	}
	return body.byteLength > 0 ? Buffer.from(body).toString("base64") : undefined;
}

function validateRelayResponse(response: BufferedRelayResponse, maxBytes: number): Buffer {
	switch (response.error_code) {
		case "unreachable":
			throw new ApiError("workspace.disconnected", "The workspace agent is unreachable.");
		case "deadline":
			throw new ApiError(
				"relay.deadline_exceeded",
				"The workspace service did not respond in time.",
			);
		case "too_large":
			throw new ApiError("relay.body_too_large", `Response body exceeds ${maxBytes} bytes.`);
		case undefined:
			break;
	}
	const body = response.body_b64 ? Buffer.from(response.body_b64, "base64") : Buffer.alloc(0);
	if (body.byteLength > maxBytes) {
		throw new ApiError("relay.body_too_large", `Response body exceeds ${maxBytes} bytes.`);
	}
	return body;
}

function safeResponseHeaders(response: RelayResponseHeaders): Headers {
	const headers = new Headers();
	for (const name of SAFE_RESPONSE_HEADERS) {
		const value = response.headers[name];
		if (value) headers.set(name, value);
	}
	return headers;
}

function validateStreamResponse(
	response: Awaited<ReturnType<Hub["relayStream"]>>,
	maxBytes: number,
): ReadableStream<Uint8Array> {
	switch (response.error_code) {
		case "streaming_unsupported":
			throw new ApiError(
				"relay.streaming_unsupported",
				"The workspace supervisor does not support streamed responses.",
			);
		case "unreachable":
			throw new ApiError("workspace.disconnected", "The workspace agent is unreachable.");
		case "deadline":
			throw new ApiError(
				"relay.deadline_exceeded",
				"The workspace service did not respond in time.",
			);
		case "too_large":
			throw new ApiError("relay.body_too_large", `Response body exceeds ${maxBytes} bytes.`);
		case undefined:
			break;
	}
	if (!response.body) {
		throw new ApiError("relay.upstream_error", "The workspace service stream did not start.");
	}
	return response.body;
}

function relayRequestHeaders(c: Context<AppEnv>): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of ["content-type", "accept"]) {
		const value = c.req.header(name);
		if (value) headers[name] = value;
	}
	return headers;
}

async function streamedRelayResponse(
	deps: RelayDeps,
	workspaceId: string,
	request: Parameters<Hub["relayStream"]>[1],
	maxResponseBytes: number,
	signal: AbortSignal,
): Promise<Response> {
	const response = await deps.hub.relayStream(workspaceId, request, maxResponseBytes);
	const body = validateStreamResponse(response, maxResponseBytes);
	const abort = () => {
		deps.hub.cancelRelayStream(workspaceId, response.request_id, "downstream_closed");
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	void deps.store
		.updateWorkspace(workspaceId, { lastActivityAt: new Date() }, new Date())
		.catch(() => {});
	return new Response(body, {
		status: response.status ?? 200,
		headers: safeResponseHeaders(response),
	});
}

export function relayHandler(
	deps: RelayDeps,
	options?: {
		service?: string;
		pathPrefix?: (workspaceId: string) => string;
		// Rewrites the base64 request body after route gates and the size cap
		// (used by the attachment-aware AgentAPI message aliases).
		transformBodyB64?: (
			c: Context<AppEnv>,
			bodyB64: string | undefined,
		) => Promise<string | undefined>;
	},
) {
	return async (c: Context<AppEnv>): Promise<Response> => {
		const principal = c.get("principal");
		const id = c.req.param("id") ?? "";
		const serviceName = options?.service ?? c.req.param("service") ?? "";
		const row = await deps.service.getOwned(principal, id);
		if (isTerminal(row.state)) {
			throw new ApiError("workspace.terminal", "This workspace has ended.");
		}
		if (row.state !== "ready") {
			throw new ApiError("workspace.not_ready", "Workspace is not ready.");
		}

		const prefix = options?.pathPrefix?.(id) ?? `/v1/workspaces/${id}/services/${serviceName}`;
		const path = requestPath(c, prefix);
		const method = c.req.method as RelayMethod;
		const match = findRoute(row.templateSnapshot, serviceName, method, path);
		if (!match) {
			throw new ApiError(
				"relay.route_not_allowed",
				`${method} ${path} is not declared by this template.`,
			);
		}
		const query = allowedQuery(c.req.url, match.route.query);
		let bodyB64 = await requestBody(c, method, match.route.maxRequestBytes);
		if (options?.transformBodyB64) bodyB64 = await options.transformBodyB64(c, bodyB64);

		if (!deps.hub.isConnected(id)) {
			throw new ApiError(
				"workspace.disconnected",
				"The workspace supervisor is not currently connected.",
			);
		}

		const request = {
			service: serviceName,
			method,
			path,
			query,
			headers: relayRequestHeaders(c),
			...(bodyB64 ? { body_b64: bodyB64 } : {}),
			deadline_ms: match.route.deadlineSeconds * 1000,
		};
		if (match.route.responseMode === "stream") {
			return await streamedRelayResponse(
				deps,
				id,
				request,
				match.route.maxResponseBytes,
				c.req.raw.signal,
			);
		}
		const response = await deps.hub.relay(id, request);
		const bodyBytes = validateRelayResponse(response, match.route.maxResponseBytes);
		// Relay activity keeps the workspace from idling out.
		void deps.store.updateWorkspace(id, { lastActivityAt: new Date() }, new Date()).catch(() => {});
		return new Response(bodyBytes, {
			status: response.status ?? 200,
			headers: safeResponseHeaders(response),
		});
	};
}
