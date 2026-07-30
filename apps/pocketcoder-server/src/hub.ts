import { randomUUID } from "node:crypto";
import {
	PROTOCOL_VERSION,
	type ProxyRequest,
	type ProxyResponse,
	type ServerFrame,
} from "@pstdio/pocketcoder-contracts";
import type { ConnectionHub } from "@pstdio/pocketcoder-runtime-core";
import type { WSContext } from "hono/ws";

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
	registered: boolean;
}

interface PendingRelay {
	resolve: (res: ProxyResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

export const MAX_INFLIGHT_RELAY = 16;

export class Hub implements ConnectionHub {
	private readonly byWorkspace = new Map<string, LiveConnection>();

	attach(workspaceId: string, connectionId: string, epoch: number, ws: WSContext): LiveConnection {
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
			registered: false,
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
			v: PROTOCOL_VERSION,
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
		if (!conn) return;
		this.dropPending(conn, "unreachable");
		this.byWorkspace.delete(workspaceId);
		try {
			conn.ws.close(1000, "workspace ended");
		} catch {
			// Already closed.
		}
	}

	relay(workspaceId: string, request: Omit<ProxyRequest, "request_id">): Promise<ProxyResponse> {
		const conn = this.byWorkspace.get(workspaceId);
		if (!conn?.registered) {
			return Promise.resolve({ request_id: randomUUID(), headers: {}, error_code: "unreachable" });
		}
		if (conn.inflight.size >= MAX_INFLIGHT_RELAY) {
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
	}
}
