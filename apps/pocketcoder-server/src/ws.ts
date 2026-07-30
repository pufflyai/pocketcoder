import { digestOpaque, generateOpaqueSecret, verifyOpaque } from "@pocketcoder/auth";
import {
	type AgentFrame,
	AgentFrameSchema,
	type ExecSpec,
	errorEnvelope,
	HEADER_PROTOCOL,
	HEADER_RECONNECT,
	HEADER_REGISTRATION,
	HEADER_WORKSPACE,
	isTerminal,
	MAX_FRAME_BYTES,
	PROTOCOL_VERSION,
	type WorkspaceState,
} from "@pocketcoder/contracts";
import type { Scheduler, Store, WorkspaceRow } from "@pocketcoder/runtime-core";
import type { MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { type Hub, type LiveConnection, MAX_INFLIGHT_RELAY } from "./hub";
import type { AppEnv } from "./middleware";

// The /v1/agent/connect endpoint. Every accepted connection represents the
// PID 1 supervisor for one workspace. First connections redeem the one-time
// registration secret; reconnects use the server-issued credential.

export interface WsDeps {
	store: Store;
	hub: Hub;
	scheduler: Scheduler;
	pepper: string;
	cleanupInput?: (workspaceId: string) => Promise<void>;
	log?: (msg: string) => void;
}

type WsMode = "register" | "reconnect";

interface WsAuth {
	workspaceId: string;
	mode: WsMode;
}

const HEARTBEAT_SECONDS = 15;
const LOG_CHUNK_BYTES = 65_536;

export function agentConnectValidator(deps: WsDeps): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const reject = (message: string) =>
			c.json(errorEnvelope("auth.invalid_key", message, c.get("requestId") ?? ""), 401);

		if (c.req.header(HEADER_PROTOCOL) !== String(PROTOCOL_VERSION)) {
			return reject("Unsupported agent protocol version.");
		}
		const workspaceId = c.req.header(HEADER_WORKSPACE) ?? "";
		const registration = c.req.header(HEADER_REGISTRATION);
		const reconnect = c.req.header(HEADER_RECONNECT);
		if (!workspaceId || (!registration && !reconnect)) {
			return reject("Missing workspace credentials.");
		}
		const row = await deps.store.getWorkspace(workspaceId);
		if (!row || isTerminal(row.state)) {
			return reject("Unknown workspace.");
		}
		let mode: WsMode;
		if (registration) {
			if (
				row.state !== "provisioning" ||
				!row.registrationDigest ||
				!row.registrationExpiresAt ||
				row.registrationExpiresAt <= new Date() ||
				!verifyOpaque(deps.pepper, registration, row.registrationDigest)
			) {
				return reject("Invalid or expired registration secret.");
			}
			mode = "register";
		} else {
			if (
				!["connected", "ready", "terminating"].includes(row.state) ||
				!row.reconnectDigest ||
				!verifyOpaque(deps.pepper, reconnect ?? "", row.reconnectDigest)
			) {
				return reject("Invalid reconnect credential.");
			}
			mode = "reconnect";
		}
		c.set("wsAuth" as never, { workspaceId, mode } as never);
		await next();
	};
}

function execSpecOf(row: WorkspaceRow): ExecSpec {
	const spec = row.templateSnapshot.spec;
	return {
		setup: spec.setup,
		harness: spec.harness,
		env: spec.env,
		services: spec.services,
		timeouts: spec.timeouts,
	};
}

export function agentWsEvents(deps: WsDeps) {
	return (c: { get: (key: string) => unknown }): WSEvents => {
		const auth = c.get("wsAuth") as WsAuth;
		let conn: LiveConnection | null = null;
		// Frames are processed strictly in arrival order; concurrent handling
		// would race log sequencing and state transitions.
		let pipeline: Promise<void> = Promise.resolve();

		const closeProtocol = (ws: WSContext, message: string) => {
			deps.log?.(`ws ${auth.workspaceId}: protocol error: ${message}`);
			ws.close(1008, message);
		};

		const handleRegistered = async (ws: WSContext, frame: AgentFrame) => {
			if (frame.type !== "registered") return;
			const row = await deps.store.getWorkspace(auth.workspaceId);
			if (!row || isTerminal(row.state)) {
				closeProtocol(ws, "workspace ended");
				return;
			}
			if (frame.payload.template.digest !== row.templateDigest) {
				closeProtocol(ws, "template digest mismatch");
				return;
			}
			const epoch = row.connectionEpoch + 1;
			let reconnectCredential: string | undefined;
			if (auth.mode === "register") {
				reconnectCredential = generateOpaqueSecret();
				const updated = await deps.store.transition(row.id, {
					from: ["provisioning"],
					to: "connected",
					at: new Date(),
					patch: {
						connectionEpoch: epoch,
						connectedAt: new Date(),
						disconnectedAt: null,
						registrationDigest: null,
						registrationExpiresAt: null,
						reconnectDigest: digestOpaque(deps.pepper, reconnectCredential),
					},
				});
				if (!updated) {
					closeProtocol(ws, "registration no longer valid");
					return;
				}
				void deps.cleanupInput?.(row.id).catch(() => {});
			} else {
				await deps.store.updateWorkspace(
					row.id,
					{ connectionEpoch: epoch, connectedAt: new Date(), disconnectedAt: null },
					new Date(),
				);
			}
			conn = deps.hub.attach(row.id, frame.connection_id, epoch, ws);
			conn.lastSeqIn = frame.seq;
			conn.registered = true;
			deps.hub.send(conn, "registered_ack", {
				epoch,
				...(reconnectCredential ? { reconnect_credential: reconnectCredential } : {}),
				limits: {
					max_frame_bytes: MAX_FRAME_BYTES,
					max_inflight_relay: MAX_INFLIGHT_RELAY,
					log_chunk_bytes: LOG_CHUNK_BYTES,
					heartbeat_seconds: HEARTBEAT_SECONDS,
				},
				exec: execSpecOf(row),
			});
		};

		const handleFrame = async (ws: WSContext, frame: AgentFrame) => {
			const { store, scheduler, hub } = deps;
			switch (frame.type) {
				case "registered":
					// Duplicate registration on a live connection.
					closeProtocol(ws, "already registered");
					return;
				case "heartbeat": {
					if (frame.payload.agentapi_state === "running") {
						await store.updateWorkspace(
							frame.workspace_id,
							{ lastActivityAt: new Date() },
							new Date(),
						);
					}
					return;
				}
				case "service_health": {
					const row = await store.getWorkspace(frame.workspace_id);
					if (!row || isTerminal(row.state)) return;
					const health = { ...row.health, [frame.payload.service]: frame.payload.health };
					await store.updateWorkspace(row.id, { health }, new Date());
					if (row.state === "connected") {
						const services = row.templateSnapshot.spec.services;
						const allRequiredHealthy = Object.entries(services)
							.filter(([, svc]) => svc.required)
							.every(([name]) => health[name] === "healthy");
						if (allRequiredHealthy) {
							const now = new Date();
							await store.transition(row.id, {
								from: ["connected"],
								to: "ready",
								at: now,
								patch: { readyAt: now, lastActivityAt: now, launchInput: null },
							});
						}
					}
					return;
				}
				case "log_chunk": {
					const content = Uint8Array.from(Buffer.from(frame.payload.content_b64, "base64"));
					await store.appendLogs(frame.workspace_id, [
						{
							stream: frame.payload.stream,
							occurredAt: new Date(frame.payload.occurred_at),
							content,
						},
					]);
					return;
				}
				case "process_state": {
					if (frame.payload.phase !== "exited") return;
					const row = await store.getWorkspace(frame.workspace_id);
					if (!row || isTerminal(row.state)) return;
					const exitCode = frame.payload.exit_code ?? null;
					const now = new Date();
					if (row.state === "terminating") {
						await scheduler.finalize(
							row,
							(row.terminalIntent ?? "failed") as WorkspaceState,
							row.reasonCode,
							now,
						);
					} else if (exitCode === 0) {
						await scheduler.finalize(row, "succeeded", "child_exit_success", now);
					} else {
						await scheduler.finalize(row, "failed", "child_exit_failure", now);
					}
					return;
				}
				case "proxy_response": {
					if (conn) hub.resolveRelay(conn, frame.payload);
					return;
				}
				case "termination_ack":
					return;
			}
		};

		return {
			onMessage: (event, ws) => {
				pipeline = pipeline.then(async () => {
					try {
						const raw =
							typeof event.data === "string"
								? event.data
								: Buffer.from(event.data as ArrayBuffer).toString("utf8");
						if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
							closeProtocol(ws, "frame too large");
							return;
						}
						const parsed = AgentFrameSchema.safeParse(JSON.parse(raw));
						if (!parsed.success) {
							closeProtocol(ws, "invalid frame");
							return;
						}
						const frame = parsed.data;
						if (frame.workspace_id !== auth.workspaceId) {
							closeProtocol(ws, "wrong workspace");
							return;
						}
						if (!conn) {
							if (frame.type !== "registered") {
								closeProtocol(ws, "not registered");
								return;
							}
							await handleRegistered(ws, frame);
							return;
						}
						if (frame.connection_id !== conn.connectionId) {
							closeProtocol(ws, "wrong connection");
							return;
						}
						if (frame.seq <= conn.lastSeqIn) {
							closeProtocol(ws, "sequence violation");
							return;
						}
						conn.lastSeqIn = frame.seq;
						await handleFrame(ws, frame);
					} catch (err) {
						deps.log?.(`ws ${auth.workspaceId}: ${String(err)}`);
						closeProtocol(ws, "internal error");
					}
				});
			},
			onClose: () => {
				void (async () => {
					if (!conn) return;
					const wasLive = deps.hub.detach(conn);
					conn.registered = false;
					if (!wasLive) return;
					const row = await deps.store.getWorkspace(auth.workspaceId);
					if (row && !isTerminal(row.state) && row.state !== "terminating") {
						await deps.store.updateWorkspace(row.id, { disconnectedAt: new Date() }, new Date());
					}
				})();
			},
		};
	};
}
