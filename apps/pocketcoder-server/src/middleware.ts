import { randomUUID } from "node:crypto";
import { parseMachineKey, verifySecret } from "@pstdio/pocketcoder-auth";
import { ApiError, errorEnvelope, hasScope, type Scope } from "@pstdio/pocketcoder-contracts";
import type { PrincipalRow, Store } from "@pstdio/pocketcoder-runtime-core";
import type { Context, MiddlewareHandler } from "hono";
import type { StructuredLogger } from "./observability";

export interface AppVariables {
	requestId: string;
	principal: PrincipalRow;
	scopes: string[];
	keyId: string;
}

export type AppEnv = { Variables: AppVariables };

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
	const candidate = c.req.header("x-request-id");
	const id = candidate && /^[A-Za-z0-9._-]{1,128}$/.test(candidate) ? candidate : randomUUID();
	c.set("requestId", id);
	c.header("x-request-id", id);
	await next();
};

export function requestLogging(logger: StructuredLogger): MiddlewareHandler<AppEnv> {
	return async (context, next) => {
		const started = performance.now();
		await next();
		const segments = new URL(context.req.url).pathname.split("/");
		const workspaceIndex = segments.indexOf("workspaces");
		const operationIndex = segments.indexOf("operations");
		logger.info("request.completed", {
			request_id: context.get("requestId"),
			method: context.req.method,
			path: new URL(context.req.url).pathname,
			status: context.res.status,
			duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
			...(workspaceIndex >= 0 && segments[workspaceIndex + 1]
				? { workspace_id: segments[workspaceIndex + 1] }
				: {}),
			...(operationIndex >= 0 && segments[operationIndex + 1]
				? { operation_id: segments[operationIndex + 1] }
				: {}),
		});
	};
}

export function machineAuth(store: Store, pepper: string): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const header = c.req.header("authorization") ?? "";
		const token = header.startsWith("Bearer ") ? header.slice(7) : "";
		const parsed = token ? parseMachineKey(token) : null;
		if (!parsed) {
			throw new ApiError("auth.invalid_key", "A valid machine key is required.");
		}
		const found = await store.getMachineKeyWithPrincipal(parsed.id);
		if (!found || !verifySecret(pepper, parsed.id, parsed.secret, found.key.secretDigest)) {
			throw new ApiError("auth.invalid_key", "A valid machine key is required.");
		}
		const now = new Date();
		if (found.key.revokedAt || (found.key.expiresAt && found.key.expiresAt <= now)) {
			throw new ApiError("auth.invalid_key", "This machine key is revoked or expired.");
		}
		if (found.principal.disabledAt) {
			throw new ApiError("auth.disabled_principal", "This principal is disabled.");
		}
		const keyScopes = found.key.scopes.length === 0 ? found.principal.scopes : found.key.scopes;
		const effectiveScopes = keyScopes.filter(
			(s) => found.principal.scopes.includes(s) || found.principal.scopes.includes("admin"),
		);
		c.set("principal", found.principal);
		c.set("scopes", effectiveScopes);
		c.set("keyId", found.key.id);
		store.touchMachineKey(found.key.id, now).catch(() => {});
		await next();
	};
}

export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (!hasScope(c.get("scopes") ?? [], scope)) {
			throw new ApiError("auth.missing_scope", `This operation requires the ${scope} scope.`);
		}
		await next();
	};
}

export function errorHandler(logger: StructuredLogger) {
	return (err: unknown, c: Context<AppEnv>): Response => {
		const id = c.get("requestId") ?? randomUUID();
		if (err instanceof ApiError) {
			return c.json(errorEnvelope(err.code, err.message, id, err.details), err.status as 400);
		}
		logger.error("request.failed", {
			request_id: id,
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json(errorEnvelope("internal.error", "Internal error.", id), 500);
	};
}
