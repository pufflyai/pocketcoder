import { randomUUID } from "node:crypto";
import {
	type ClientTerminalMessage,
	PROTOCOL_VERSION,
	type ProtocolVersion,
	type ProxyRequest,
	type ProxyResponse,
	type ProxyStreamChunk,
	type ProxyStreamEnd,
	type ProxyStreamStart,
	type ServerFrame,
	STREAMING_MIN_PROTOCOL_VERSION,
	type TerminalClosed,
	type TerminalOpened,
	type TerminalOutput,
} from "@pstdio/pocketcoder-contracts";
import type { ConnectionHub } from "@pstdio/pocketcoder-runtime-core";
import type { WSContext } from "hono/ws";
import {
	type AttachmentChannel,
	type AttachmentEvent,
	AttachmentRegistry,
} from "./hub-attachments";
import {
	type RelayStreamChannel,
	RelayStreamRegistry,
	type RelayStreamResponse,
} from "./relay-stream-channel";
import { type TerminalBridgeCallbacks, TerminalBridgeRegistry } from "./terminal-bridge";

// In-memory registry of live supervisor connections. Exactly one connection
// (the latest accepted epoch) may speak for a workspace. Nothing here is
// durable; PostgreSQL only records epoch metadata.

export interface LiveConnection {
	workspaceId: string;
	connectionId: string;
	epoch: number;
	ws: WSContext;
	lastSeqIn: number;
	seqOut: number;
	inflight: Map<string, PendingRelay>;
	streams: Map<string, RelayStreamChannel>;
	registered: boolean;
	protocolVersion: ProtocolVersion;
	checkpoints: Map<string, PendingCheckpoint>;
	attachments: Map<string, AttachmentChannel>;
}

interface PendingRelay {
	resolve: (res: ProxyResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingCheckpoint {
	resolve: (quiesced: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

export const MAX_INFLIGHT_RELAY = 16;

export class Hub implements ConnectionHub {
	private readonly byWorkspace = new Map<string, LiveConnection>();
	private readonly attachments = new AttachmentRegistry<LiveConnection>(
		(connection) => this.byWorkspace.get(connection.workspaceId) === connection,
	);
	private readonly terminals: TerminalBridgeRegistry;
	private readonly relayStreams = new RelayStreamRegistry<LiveConnection>(
		(connection) => this.byWorkspace.get(connection.workspaceId) === connection,
		(connection, type, payload) => this.send(connection, type, payload),
	);

	constructor(callbacks: TerminalBridgeCallbacks = {}) {
		this.terminals = new TerminalBridgeRegistry(callbacks);
	}

	attach(
		workspaceId: string,
		connectionId: string,
		epoch: number,
		ws: WSContext,
		protocolVersion: ProtocolVersion = PROTOCOL_VERSION,
	): LiveConnection {
		// A newer connection replaces an older one; the stale socket closes.
		const existing = this.byWorkspace.get(workspaceId);
		if (existing) {
			this.dropPending(existing, "unreachable");
			try {
				existing.ws.close(1000, "replaced by newer connection");
			} catch {
				// Already closed.
			}
		}
		const conn: LiveConnection = {
			workspaceId,
			connectionId,
			epoch,
			ws,
			lastSeqIn: -1,
			seqOut: 0,
			inflight: new Map(),
			streams: new Map(),
			registered: false,
			protocolVersion,
			checkpoints: new Map(),
			attachments: new Map(),
		};
		this.byWorkspace.set(workspaceId, conn);
		return conn;
	}

	// Detaches only if `conn` is still the live connection for its workspace.
	detach(conn: LiveConnection): boolean {
		const current = this.byWorkspace.get(conn.workspaceId);
		if (current !== conn) return false;
		this.dropPending(conn, "unreachable");
		this.byWorkspace.delete(conn.workspaceId);
		return true;
	}

	get(workspaceId: string): LiveConnection | undefined {
		return this.byWorkspace.get(workspaceId);
	}

	isConnected(workspaceId: string): boolean {
		return this.byWorkspace.get(workspaceId)?.registered === true;
	}

	send(conn: LiveConnection, type: ServerFrame["type"], payload: unknown): void {
		conn.seqOut += 1;
		const frame = {
			v: conn.protocolVersion,
			type,
			workspace_id: conn.workspaceId,
			connection_id: conn.connectionId,
			seq: conn.seqOut,
			sent_at: new Date().toISOString(),
			payload,
		};
		conn.ws.send(JSON.stringify(frame));
	}

	shutdown(workspaceId: string, reason: string): boolean {
		const conn = this.byWorkspace.get(workspaceId);
		if (!conn) return false;
		this.send(conn, "shutdown", { reason });
		return true;
	}

	signal(workspaceId: string, signal: "TERM" | "KILL"): boolean {
		const conn = this.byWorkspace.get(workspaceId);
		if (!conn) return false;
		this.send(conn, "signal", { signal });
		return true;
	}

	close(workspaceId: string): void {
		const conn = this.byWorkspace.get(workspaceId);
		if (!conn) {
			this.terminals.closeWorkspace(workspaceId);
			return;
		}
		this.dropPending(conn, "unreachable");
		this.terminals.closeWorkspace(workspaceId);
		this.byWorkspace.delete(workspaceId);
		try {
			conn.ws.close(1000, "workspace ended");
		} catch {
			// Already closed.
		}
	}

	prepareCheckpoint(
		workspaceId: string,
		operationId: string,
		deadlineMs: number,
	): Promise<boolean> {
		const conn = this.byWorkspace.get(workspaceId);
		if (!conn?.registered || conn.protocolVersion < 2) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				conn.checkpoints.delete(operationId);
				resolve(false);
			}, deadlineMs);
			conn.checkpoints.set(operationId, { resolve, timer });
			this.send(conn, "prepare_checkpoint", {
				operation_id: operationId,
				deadline_ms: deadlineMs,
			});
		});
	}

	resolveCheckpoint(
		conn: LiveConnection,
		operationId: string,
		phase: "quiescing" | "quiesced" | "failed",
	): void {
		const current = this.byWorkspace.get(conn.workspaceId);
		if (current !== conn || phase === "quiescing") return;
		const pending = conn.checkpoints.get(operationId);
		if (!pending) return;
		clearTimeout(pending.timer);
		conn.checkpoints.delete(operationId);
		pending.resolve(phase === "quiesced");
	}

	relay(workspaceId: string, request: Omit<ProxyRequest, "request_id">): Promise<ProxyResponse> {
		const conn = this.byWorkspace.get(workspaceId);
		if (!conn?.registered) {
			return Promise.resolve({ request_id: randomUUID(), headers: {}, error_code: "unreachable" });
		}
		if (conn.inflight.size + conn.streams.size >= MAX_INFLIGHT_RELAY) {
			return Promise.resolve({ request_id: randomUUID(), headers: {}, error_code: "deadline" });
		}
		const requestId = randomUUID();
		return new Promise<ProxyResponse>((resolve) => {
			const timer = setTimeout(() => {
				conn.inflight.delete(requestId);
				resolve({ request_id: requestId, headers: {}, error_code: "deadline" });
			}, request.deadline_ms);
			conn.inflight.set(requestId, { resolve, timer });
			this.send(conn, "proxy_request", { ...request, request_id: requestId });
		});
	}

	relayStream(
		workspaceId: string,
		request: Omit<ProxyRequest, "request_id">,
		maxResponseBytes: number,
	): Promise<RelayStreamResponse> {
		const conn = this.byWorkspace.get(workspaceId);
		const requestId = randomUUID();
		if (!conn?.registered) {
			return Promise.resolve({ request_id: requestId, headers: {}, error_code: "unreachable" });
		}
		if (conn.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
			return Promise.resolve({
				request_id: requestId,
				headers: {},
				error_code: "streaming_unsupported",
			});
		}
		if (conn.inflight.size + conn.streams.size >= MAX_INFLIGHT_RELAY) {
			return Promise.resolve({ request_id: requestId, headers: {}, error_code: "deadline" });
		}
		const response = this.relayStreams.open(conn, requestId, maxResponseBytes, request.deadline_ms);
		this.send(conn, "proxy_request", { ...request, request_id: requestId });
		return response;
	}

	startRelayStream(conn: LiveConnection, payload: ProxyStreamStart): void {
		this.relayStreams.start(conn, payload);
	}

	pushRelayStreamChunk(conn: LiveConnection, payload: ProxyStreamChunk): void {
		this.relayStreams.push(conn, payload);
	}

	endRelayStream(conn: LiveConnection, payload: ProxyStreamEnd): void {
		this.relayStreams.end(conn, payload);
	}

	cancelRelayStream(
		workspaceId: string,
		requestId: string,
		reason: "downstream_closed" | "deadline" | "too_large" | "workspace_disconnected",
	): void {
		const conn = this.byWorkspace.get(workspaceId);
		if (conn) {
			this.relayStreams.cancel(conn, requestId, reason, reason !== "downstream_closed");
		}
	}

	activeStreamCount(workspaceId: string): number {
		return this.byWorkspace.get(workspaceId)?.streams.size ?? 0;
	}

	openTerminal(
		workspaceId: string,
		sessionId: string,
		client: WSContext,
		reattach: boolean,
		rows: number,
		cols: number,
	): void {
		const conn = this.byWorkspace.get(workspaceId);
		this.terminals.open(
			workspaceId,
			sessionId,
			client,
			reattach,
			rows,
			cols,
			conn?.registered ? (type, payload) => this.send(conn, type, payload) : null,
		);
	}

	terminalClientMessage(
		workspaceId: string,
		sessionId: string,
		client: WSContext,
		message: ClientTerminalMessage,
	): void {
		const conn = this.byWorkspace.get(workspaceId);
		const bridge = this.terminals.client(workspaceId, sessionId, client);
		if (!conn?.registered || !bridge) return;
		this.terminals.clientMessage(bridge, message, (type, payload) =>
			this.send(conn, type, payload),
		);
	}

	detachTerminalClient(workspaceId: string, sessionId: string, client: WSContext): void {
		this.terminals.detachClient(workspaceId, sessionId, client);
	}

	terminalOpened(conn: LiveConnection, payload: TerminalOpened): void {
		if (this.byWorkspace.get(conn.workspaceId) === conn) {
			this.terminals.opened(conn.workspaceId, payload);
		}
	}

	terminalOutput(conn: LiveConnection, payload: TerminalOutput): void {
		if (this.byWorkspace.get(conn.workspaceId) === conn) {
			this.terminals.output(conn.workspaceId, payload);
		}
	}

	terminalClosed(conn: LiveConnection, payload: TerminalClosed): void {
		if (this.byWorkspace.get(conn.workspaceId) === conn) {
			this.terminals.closed(conn.workspaceId, payload);
		}
	}

	resumeTerminals(conn: LiveConnection): void {
		this.terminals.resume(conn.workspaceId, (type, payload) => this.send(conn, type, payload));
	}

	openAttachment(conn: LiveConnection, operationId: string): void {
		this.attachments.open(conn, operationId);
	}

	closeAttachment(conn: LiveConnection, operationId: string): void {
		this.attachments.close(conn, operationId);
	}

	// Delivers a supervisor attachment reply; ignores stale epochs and
	// operations the server is no longer waiting on.
	pushAttachment(conn: LiveConnection, event: AttachmentEvent): void {
		this.attachments.push(conn, event);
	}

	nextAttachment(
		conn: LiveConnection,
		operationId: string,
		timeoutMs: number,
	): Promise<AttachmentEvent | null> {
		return this.attachments.next(conn, operationId, timeoutMs);
	}

	// Resolves a pending relay; ignores responses from stale epochs or after
	// the deadline already fired.
	resolveRelay(conn: LiveConnection, response: ProxyResponse): void {
		const current = this.byWorkspace.get(conn.workspaceId);
		if (current !== conn) return;
		const pending = conn.inflight.get(response.request_id);
		if (!pending) return;
		clearTimeout(pending.timer);
		conn.inflight.delete(response.request_id);
		pending.resolve(response);
	}

	private dropPending(conn: LiveConnection, errorCode: "unreachable"): void {
		for (const [id, pending] of conn.inflight) {
			clearTimeout(pending.timer);
			pending.resolve({ request_id: id, headers: {}, error_code: errorCode });
		}
		conn.inflight.clear();
		this.relayStreams.drop(conn);
		this.terminals.disconnect(conn.workspaceId);
		for (const pending of conn.checkpoints.values()) {
			clearTimeout(pending.timer);
			pending.resolve(false);
		}
		conn.checkpoints.clear();
		this.attachments.drop(conn);
	}
}
