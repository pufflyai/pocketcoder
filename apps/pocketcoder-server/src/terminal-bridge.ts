import type {
	ClientTerminalMessage,
	TerminalClosed,
	TerminalOpened,
	TerminalOutput,
} from "@pstdio/pocketcoder-contracts";
import type { WSContext } from "hono/ws";

interface Bridge {
	workspaceId: string;
	sessionId: string;
	client: WSContext | null;
	rows: number;
	cols: number;
	bytesIn: number;
	bytesOut: number;
	started: boolean;
}

export interface TerminalBridgeClosed extends TerminalClosed {
	workspaceId: string;
	bytesIn: number;
	bytesOut: number;
}

export interface TerminalBridgeCallbacks {
	onTerminalInput?(workspaceId: string): void | Promise<void>;
	onTerminalClosed?(event: TerminalBridgeClosed): void | Promise<void>;
}

type SendAgent = (
	type: "terminal_open" | "terminal_input" | "terminal_resize",
	payload: unknown,
) => void;

export class TerminalBridgeRegistry {
	private readonly byWorkspace = new Map<string, Map<string, Bridge>>();

	constructor(private readonly callbacks: TerminalBridgeCallbacks = {}) {}

	open(
		workspaceId: string,
		sessionId: string,
		client: WSContext,
		reattach: boolean,
		rows: number,
		cols: number,
		send: SendAgent | null,
	): void {
		const sessions = this.sessions(workspaceId);
		const existing = sessions.get(sessionId);
		if (existing?.client && !sameClient(existing.client, client)) {
			existing.client.close(1000, "replaced by newer terminal client");
		}
		const bridge = existing ?? {
			workspaceId,
			sessionId,
			client,
			rows,
			cols,
			bytesIn: 0,
			bytesOut: 0,
			started: reattach,
		};
		Object.assign(bridge, { client, rows, cols });
		sessions.set(sessionId, bridge);
		if (!send) {
			this.sendClient(client, { type: "status", state: "reconnecting" });
			return;
		}
		send("terminal_open", { session_id: sessionId, rows, cols, reattach });
		bridge.started = true;
	}

	clientMessage(bridge: Bridge, message: ClientTerminalMessage, send: SendAgent): void {
		if (message.type === "input") {
			bridge.bytesIn += decodedBytes(message.data_b64);
			void this.callbacks.onTerminalInput?.(bridge.workspaceId);
			send("terminal_input", { session_id: bridge.sessionId, data_b64: message.data_b64 });
			return;
		}
		bridge.rows = message.rows;
		bridge.cols = message.cols;
		send("terminal_resize", { session_id: bridge.sessionId, ...message });
	}

	opened(workspaceId: string, payload: TerminalOpened): void {
		const bridge = this.get(workspaceId, payload.session_id);
		if (!bridge?.client) return;
		this.sendClient(bridge.client, { type: "opened", ...payload });
	}

	output(workspaceId: string, payload: TerminalOutput): void {
		const bridge = this.get(workspaceId, payload.session_id);
		if (!bridge) return;
		bridge.bytesOut += decodedBytes(payload.data_b64);
		if (bridge.client)
			this.sendClient(bridge.client, { type: "output", data_b64: payload.data_b64 });
	}

	closed(workspaceId: string, payload: TerminalClosed): void {
		const bridge = this.get(workspaceId, payload.session_id);
		if (!bridge) return;
		if (bridge.client) {
			this.sendClient(bridge.client, {
				type: "closed",
				reason: clientCloseReason(payload.reason),
				...(payload.exit_code !== undefined ? { exit_code: payload.exit_code } : {}),
			});
		}
		this.delete(bridge);
		void this.callbacks.onTerminalClosed?.({
			...payload,
			workspaceId,
			bytesIn: bridge.bytesIn,
			bytesOut: bridge.bytesOut,
		});
	}

	detachClient(workspaceId: string, sessionId: string, client: WSContext): void {
		const bridge = this.get(workspaceId, sessionId);
		if (bridge?.client && sameClient(bridge.client, client)) bridge.client = null;
	}

	client(workspaceId: string, sessionId: string, client: WSContext): Bridge | null {
		const bridge = this.get(workspaceId, sessionId);
		return bridge?.client && sameClient(bridge.client, client) ? bridge : null;
	}

	disconnect(workspaceId: string): void {
		for (const bridge of this.byWorkspace.get(workspaceId)?.values() ?? []) {
			if (bridge.client) this.sendClient(bridge.client, { type: "status", state: "reconnecting" });
		}
	}

	resume(workspaceId: string, send: SendAgent): void {
		for (const bridge of this.byWorkspace.get(workspaceId)?.values() ?? []) {
			if (bridge.client) this.sendClient(bridge.client, { type: "status", state: "resumed" });
			send("terminal_open", {
				session_id: bridge.sessionId,
				rows: bridge.rows,
				cols: bridge.cols,
				reattach: bridge.started,
			});
			bridge.started = true;
		}
	}

	closeWorkspace(workspaceId: string): void {
		for (const bridge of [...(this.byWorkspace.get(workspaceId)?.values() ?? [])]) {
			this.closed(workspaceId, {
				session_id: bridge.sessionId,
				reason: "workspace_ended",
				exit_code: null,
			});
		}
	}

	private sessions(workspaceId: string): Map<string, Bridge> {
		const existing = this.byWorkspace.get(workspaceId);
		if (existing) return existing;
		const sessions = new Map<string, Bridge>();
		this.byWorkspace.set(workspaceId, sessions);
		return sessions;
	}

	private get(workspaceId: string, sessionId: string): Bridge | undefined {
		return this.byWorkspace.get(workspaceId)?.get(sessionId);
	}

	private delete(bridge: Bridge): void {
		const sessions = this.byWorkspace.get(bridge.workspaceId);
		sessions?.delete(bridge.sessionId);
		if (sessions?.size === 0) this.byWorkspace.delete(bridge.workspaceId);
	}

	private sendClient(client: WSContext, message: unknown): void {
		try {
			client.send(JSON.stringify(message));
		} catch {
			// A detached client can race the supervisor's final frame.
		}
	}
}

function sameClient(left: WSContext, right: WSContext): boolean {
	return left === right || (left.raw !== undefined && left.raw === right.raw);
}

function decodedBytes(value: string): number {
	return Buffer.from(value, "base64").byteLength;
}

function clientCloseReason(reason: TerminalClosed["reason"]) {
	return reason === "error" || reason === "closed" ? "agent_detached" : reason;
}
