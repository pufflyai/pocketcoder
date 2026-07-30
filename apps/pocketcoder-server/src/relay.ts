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

const SAFE_RESPONSE_HEADERS = ["content-type"];

export function relayHandler(deps: RelayDeps) {
	return async (c: Context<AppEnv>): Promise<Response> => {
		const principal = c.get("principal");
		const id = c.req.param("id") ?? "";
		const serviceName = c.req.param("service") ?? "";
		const row = await deps.service.getOwned(principal, id);
		if (isTerminal(row.state)) {
			throw new ApiError("workspace.terminal", "This workspace has ended.");
		}
		if (row.state !== "ready") {
			throw new ApiError("workspace.not_ready", "Workspace is not ready.");
		}

		const prefix = `/v1/workspaces/${id}/services/${serviceName}`;
		const rawPath = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
		const path = rawPath === "" ? "/" : rawPath;
		const method = c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
		const match = findRoute(row.templateSnapshot, serviceName, method, path);
		if (!match) {
			throw new ApiError(
				"relay.route_not_allowed",
				`${method} ${path} is not declared by this template.`,
			);
		}
		const query: Record<string, string> = {};
		for (const [key, value] of new URL(c.req.url).searchParams) {
			if (!match.route.query.includes(key)) {
				throw new ApiError("relay.route_not_allowed", `Query field not allowed: ${key}.`);
			}
			query[key] = value;
		}

		let bodyB64: string | undefined;
		if (method !== "GET") {
			const body = await c.req.arrayBuffer();
			if (body.byteLength > match.route.maxRequestBytes) {
				throw new ApiError(
					"relay.body_too_large",
					`Request body exceeds ${match.route.maxRequestBytes} bytes.`,
				);
			}
			if (body.byteLength > 0) {
				bodyB64 = Buffer.from(body).toString("base64");
			}
		}

		if (!deps.hub.isConnected(id)) {
			throw new ApiError(
				"workspace.disconnected",
				"The workspace supervisor is not currently connected.",
			);
		}

		const contentType = c.req.header("content-type");
		const response = await deps.hub.relay(id, {
			service: serviceName,
			method,
			path,
			query,
			headers: contentType ? { "content-type": contentType } : {},
			...(bodyB64 ? { body_b64: bodyB64 } : {}),
			deadline_ms: match.route.deadlineSeconds * 1000,
		});

		switch (response.error_code) {
			case "unreachable":
				throw new ApiError("workspace.disconnected", "The workspace agent is unreachable.");
			case "deadline":
				throw new ApiError(
					"relay.deadline_exceeded",
					"The workspace service did not respond in time.",
				);
			case "too_large":
				throw new ApiError(
					"relay.body_too_large",
					`Response body exceeds ${match.route.maxResponseBytes} bytes.`,
				);
			case undefined:
				break;
		}

		const bodyBytes = response.body_b64
			? Buffer.from(response.body_b64, "base64")
			: Buffer.alloc(0);
		if (bodyBytes.byteLength > match.route.maxResponseBytes) {
			throw new ApiError(
				"relay.body_too_large",
				`Response body exceeds ${match.route.maxResponseBytes} bytes.`,
			);
		}
		// Relay activity keeps the workspace from idling out.
		void deps.store.updateWorkspace(id, { lastActivityAt: new Date() }, new Date()).catch(() => {});

		const headers = new Headers();
		for (const name of SAFE_RESPONSE_HEADERS) {
			const value = response.headers[name];
			if (value) headers.set(name, value);
		}
		return new Response(bodyBytes, { status: response.status ?? 200, headers });
	};
}
