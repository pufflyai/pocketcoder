import { randomUUID } from "node:crypto";
import {
	ApiError,
	ClientTerminalMessageSchema,
	isTerminal,
	TERMINAL_MIN_PROTOCOL_VERSION,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import type { Context, MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { z } from "zod";
import type { Hub } from "./hub";
import type { AppEnv } from "./middleware";
import type { WorkspaceService } from "./service";

export interface TerminalWsDeps {
	store: Store;
	hub: Hub;
	service: WorkspaceService;
}

interface TerminalWsAuth {
	workspaceId: string;
	sessionId: string;
	reattach: boolean;
	rows: number;
	cols: number;
}

const SessionIdSchema = z.uuid();

export function terminalConnectValidator(deps: TerminalWsDeps): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const { workspaceId, maxSessions } = await terminalCapability(deps, c);
		const { sessionId, reattach } = await terminalSession(deps, c, workspaceId, maxSessions);
		c.set(
			"terminalAuth" as never,
			{ workspaceId, sessionId, reattach, rows: 24, cols: 80 } as never,
		);
		await next();
	};
}

async function terminalCapability(deps: TerminalWsDeps, c: Context<AppEnv>) {
	const workspaceId = c.req.param("id") ?? "";
	const workspace = await deps.service.getOwned(c.get("principal"), workspaceId);
	if (isTerminal(workspace.state)) {
		throw new ApiError("workspace.terminal", "This workspace has ended.");
	}
	if (workspace.state !== "ready") {
		throw new ApiError("workspace.not_ready", "Workspace is not ready.");
	}
	const terminal = workspace.templateSnapshot.spec.terminal;
	if (!terminal) {
		throw new ApiError("terminal.not_declared", "This workspace template has no terminal.");
	}
	const connection = deps.hub.get(workspaceId);
	if (!connection?.registered) {
		throw new ApiError(
			"workspace.disconnected",
			"The workspace supervisor is not currently connected.",
		);
	}
	if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
		throw new ApiError(
			"terminal.protocol_unsupported",
			"The workspace supervisor does not support terminal sessions.",
		);
	}
	return { workspaceId, maxSessions: terminal.maxSessions };
}

async function terminalSession(
	deps: TerminalWsDeps,
	c: Context<AppEnv>,
	workspaceId: string,
	maxSessions: number,
) {
	const requested = new URL(c.req.url).searchParams.get("session");
	const parsedSessionId = requested ? SessionIdSchema.safeParse(requested) : null;
	if (parsedSessionId && !parsedSessionId.success) {
		throw new ApiError("validation.invalid", "Invalid terminal session id.");
	}
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		throw new ApiError("validation.invalid", "WebSocket upgrade required.");
	}
	const sessionId = parsedSessionId?.data ?? randomUUID();
	if (requested) {
		const session = await deps.store.getTerminalSession(sessionId);
		if (!session || session.workspaceId !== workspaceId) {
			throw new ApiError("terminal.session_not_found", "Terminal session not found.");
		}
		if (session.closedAt) {
			throw new ApiError("terminal.session_closed", "Terminal session has already closed.");
		}
		return { sessionId, reattach: true };
	}

	const openedAt = new Date();
	const session = await deps.store.openTerminalSession(
		{ sessionId, workspaceId, keyId: c.get("keyId"), openedAt },
		maxSessions,
	);
	if (!session) throw new ApiError("terminal.session_limit", "Terminal session limit reached.");
	await deps.store.appendEvent(
		workspaceId,
		"workspace.terminal_opened",
		{
			session_id: sessionId,
			key_id: session.keyId,
			opened_at: session.openedAt.toISOString(),
		},
		openedAt,
	);
	return { sessionId, reattach: false };
}

export function terminalWsEvents(deps: TerminalWsDeps) {
	return (c: { get: (key: string) => unknown }): WSEvents => {
		const auth = c.get("terminalAuth") as TerminalWsAuth;
		return {
			onOpen: (_event, ws) => {
				deps.hub.openTerminal(
					auth.workspaceId,
					auth.sessionId,
					ws,
					auth.reattach,
					auth.rows,
					auth.cols,
				);
			},
			onMessage: (event, ws) => handleClientMessage(deps, auth, event.data, ws),
			onClose: (_event, ws) => {
				deps.hub.detachTerminalClient(auth.workspaceId, auth.sessionId, ws);
			},
		};
	};
}

function handleClientMessage(
	deps: TerminalWsDeps,
	auth: TerminalWsAuth,
	raw: unknown,
	ws: WSContext,
): void {
	let value: unknown;
	if (typeof raw !== "string") {
		ws.close(1008, "terminal messages must be JSON text");
		return;
	}
	try {
		value = JSON.parse(raw);
	} catch {
		ws.close(1008, "invalid terminal message");
		return;
	}
	const parsed = ClientTerminalMessageSchema.safeParse(value);
	if (!parsed.success) {
		ws.close(1008, "invalid terminal message");
		return;
	}
	deps.hub.terminalClientMessage(auth.workspaceId, auth.sessionId, ws, parsed.data);
}
