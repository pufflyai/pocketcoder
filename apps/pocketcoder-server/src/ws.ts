import { digestOpaque, generateOpaqueSecret, verifyOpaque } from "@pstdio/pocketcoder-auth";
import {
	type AgentFrame,
	AgentFrameSchema,
	agentApiHarness,
	type ExecSpec,
	errorEnvelope,
	HEADER_PROTOCOL,
	HEADER_RECONNECT,
	HEADER_REGISTRATION,
	HEADER_WORKSPACE,
	isAgentApiNative,
	isTerminal,
	MAX_FRAME_BYTES,
	type ProtocolVersion,
	parseDurationMs,
	STREAMING_MIN_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	secretMountPath,
	snapshotServices,
	TERMINAL_MIN_PROTOCOL_VERSION,
	TERMINAL_REPLAY_BUFFER_BYTES,
	type WorkspaceState,
} from "@pstdio/pocketcoder-contracts";
import type { Scheduler, Store, WorkspaceRow } from "@pstdio/pocketcoder-runtime-core";
import type { MiddlewareHandler } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { type Hub, type LiveConnection, MAX_INFLIGHT_RELAY } from "./hub";
import type { AppEnv } from "./middleware";
import type { PersistenceService } from "./persistence";

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
	persistence?: PersistenceService;
}

type WsMode = "register" | "reconnect";

interface WsAuth {
	workspaceId: string;
	mode: WsMode;
	protocolVersion: ProtocolVersion;
}

const HEARTBEAT_SECONDS = 15;
const LOG_CHUNK_BYTES = 65_536;

interface WsCredentials {
	protocolVersion: number;
	workspaceId: string;
	registration?: string;
	reconnect?: string;
}

type WsAuthResult = { auth: WsAuth } | { error: string };

function validRegistration(deps: WsDeps, row: WorkspaceRow, secret: string): boolean {
	return (
		row.state === "provisioning" &&
		row.registrationDigest !== null &&
		row.registrationExpiresAt !== null &&
		row.registrationExpiresAt > new Date() &&
		verifyOpaque(deps.pepper, secret, row.registrationDigest)
	);
}

function validReconnect(deps: WsDeps, row: WorkspaceRow, secret: string): boolean {
	return (
		["connected", "ready", "preserving", "terminating"].includes(row.state) &&
		row.reconnectDigest !== null &&
		verifyOpaque(deps.pepper, secret, row.reconnectDigest)
	);
}

async function authenticateConnection(
	deps: WsDeps,
	credentials: WsCredentials,
): Promise<WsAuthResult> {
	if (!SUPPORTED_PROTOCOL_VERSIONS.includes(credentials.protocolVersion as ProtocolVersion)) {
		return { error: "Unsupported agent protocol version." };
	}
	if (!credentials.workspaceId || (!credentials.registration && !credentials.reconnect)) {
		return { error: "Missing workspace credentials." };
	}
	const row = await deps.store.getWorkspace(credentials.workspaceId);
	if (!row || isTerminal(row.state)) return { error: "Unknown workspace." };
	if (credentials.registration) {
		if (!validRegistration(deps, row, credentials.registration)) {
			return { error: "Invalid or expired registration secret." };
		}
		return {
			auth: {
				workspaceId: credentials.workspaceId,
				mode: "register",
				protocolVersion: credentials.protocolVersion as ProtocolVersion,
			},
		};
	}
	if (!validReconnect(deps, row, credentials.reconnect ?? "")) {
		return { error: "Invalid reconnect credential." };
	}
	return {
		auth: {
			workspaceId: credentials.workspaceId,
			mode: "reconnect",
			protocolVersion: credentials.protocolVersion as ProtocolVersion,
		},
	};
}

export function agentConnectValidator(deps: WsDeps): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const reject = (message: string) =>
			c.json(errorEnvelope("auth.invalid_key", message, c.get("requestId") ?? ""), 401);
		const result = await authenticateConnection(deps, {
			protocolVersion: Number(c.req.header(HEADER_PROTOCOL)),
			workspaceId: c.req.header(HEADER_WORKSPACE) ?? "",
			...(c.req.header(HEADER_REGISTRATION)
				? { registration: c.req.header(HEADER_REGISTRATION) }
				: {}),
			...(c.req.header(HEADER_RECONNECT) ? { reconnect: c.req.header(HEADER_RECONNECT) } : {}),
		});
		if ("error" in result) return reject(result.error);
		c.set("wsAuth" as never, result.auth as never);
		await next();
	};
}

function execSpecOf(row: WorkspaceRow): ExecSpec {
	const spec = row.templateSnapshot.spec;
	const sourceSpec = spec.source;
	const sourceRepository =
		sourceSpec && row.sourceDescriptor
			? sourceSpec.repositories[row.sourceDescriptor.repository]
			: undefined;
	const sourceMount =
		sourceSpec &&
		spec.persistence.mounts.find((mount) => mount.name === sourceSpec.destinationMount);
	const harness = agentApiHarness(spec);
	const native = isAgentApiNative(spec);
	return {
		agentapi_native: native,
		setup: spec.setup
			.filter((step) => step.runOn.includes(row.launchMode))
			.map((step) => ({ ...step, env: materializeSecretEnv(step.env) })),
		harness: {
			...harness,
			env: materializeSecretEnv(harness.env),
		},
		env: materializeSecretEnv(spec.env),
		services: snapshotServices(row.templateSnapshot),
		terminal: spec.terminal
			? {
					command: spec.terminal.command,
					env: materializeSecretEnv(spec.terminal.env),
					...(spec.terminal.cwd ? { cwd: spec.terminal.cwd } : {}),
					max_sessions: spec.terminal.maxSessions,
					idle_timeout_seconds: Math.ceil(parseDurationMs(spec.terminal.idleTimeout) / 1000),
					replay_buffer_bytes: TERMINAL_REPLAY_BUFFER_BYTES,
				}
			: null,
		timeouts: spec.timeouts,
		security: {
			writable_memory_paths: spec.security.writableMemoryPaths,
		},
		network:
			spec.network.mode === "restricted"
				? {
						mode: "restricted",
						proxy_url: "http://127.0.0.1:18080",
						health_url: "http://127.0.0.1:18082/healthz",
					}
				: { mode: "unrestricted" },
		launch_mode: row.launchMode,
		source:
			row.sourceDescriptor && sourceRepository && sourceMount
				? {
						...row.sourceDescriptor,
						url: sourceRepository.url,
						destination: sourceMount.target,
						credential_path: sourceRepository.credential
							? secretMountPath(sourceRepository.credential)
							: null,
					}
				: null,
		restore:
			row.restoredFromCheckpointId && row.originWorkspaceId
				? {
						checkpoint_id: row.restoredFromCheckpointId,
						origin_workspace_id: row.originWorkspaceId,
					}
				: null,
		persistence: {
			mounts: spec.persistence.mounts.map(({ name, target }) => ({ name, target })),
			conversation_restore: row.persistenceCapability,
		},
		checkpoint_hook:
			!native && spec.checkpointHook
				? {
						command: spec.checkpointHook.command,
						timeout_seconds: spec.checkpointHook.timeoutSeconds,
						env: materializeSecretEnv(spec.checkpointHook.env),
						...(spec.checkpointHook.cwd ? { cwd: spec.checkpointHook.cwd } : {}),
					}
				: null,
		outputs: spec.outputs,
	};
}

function materializeSecretEnv(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).map(([key, value]) => [
			key,
			value.startsWith("secretRef:") ? secretMountPath(value) : value,
		]),
	);
}

type RegisteredFrame = Extract<AgentFrame, { type: "registered" }>;
type ServiceHealthFrame = Extract<AgentFrame, { type: "service_health" }>;
type ProcessStateFrame = Extract<AgentFrame, { type: "process_state" }>;
type AgentStateFrame = Extract<AgentFrame, { type: "agent_state" }>;
type NetworkStateFrame = Extract<AgentFrame, { type: "network_state" }>;
type CloseProtocol = (ws: WSContext, message: string) => void;

async function registerConnection(
	deps: WsDeps,
	auth: WsAuth,
	ws: WSContext,
	frame: RegisteredFrame,
	closeProtocol: CloseProtocol,
): Promise<LiveConnection | null> {
	const row = await deps.store.getWorkspace(auth.workspaceId);
	if (!row || isTerminal(row.state)) {
		closeProtocol(ws, "workspace ended");
		return null;
	}
	if (frame.payload.template.digest !== row.templateDigest) {
		closeProtocol(ws, "template digest mismatch");
		return null;
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
			return null;
		}
		void deps.cleanupInput?.(row.id).catch(() => {});
	} else {
		await deps.store.updateWorkspace(
			row.id,
			{ connectionEpoch: epoch, connectedAt: new Date(), disconnectedAt: null },
			new Date(),
		);
	}
	const connection = deps.hub.attach(row.id, frame.connection_id, epoch, ws, auth.protocolVersion);
	connection.lastSeqIn = frame.seq;
	connection.registered = true;
	deps.hub.send(connection, "registered_ack", {
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
	deps.hub.resumeTerminals(connection);
	return connection;
}

async function handleServiceHealth(deps: WsDeps, frame: ServiceHealthFrame): Promise<void> {
	const row = await deps.store.getWorkspace(frame.workspace_id);
	if (!row || isTerminal(row.state)) return;
	const health = { ...row.health, [frame.payload.service]: frame.payload.health };
	await deps.store.updateWorkspace(row.id, { health }, new Date());
	await maybeMarkReady(deps, row, health, row.networkState);
}

async function maybeMarkReady(
	deps: WsDeps,
	row: WorkspaceRow,
	health: Record<string, string>,
	networkState: WorkspaceRow["networkState"],
) {
	if (row.state !== "connected") return;
	const allRequiredHealthy = Object.entries(snapshotServices(row.templateSnapshot))
		.filter(([, service]) => service.required)
		.every(([name]) => health[name] === "healthy");
	if (!allRequiredHealthy) return;
	if (row.templateSnapshot.spec.network.mode === "restricted" && networkState !== "ready") return;
	const now = new Date();
	if (row.sourceDescriptor && !row.resolvedSource) {
		await deps.scheduler.finalize(row, "failed", "source_resolution_failed", now);
		return;
	}
	await deps.store.transition(row.id, {
		from: ["connected"],
		to: "ready",
		at: now,
		patch: { readyAt: now, lastActivityAt: now, launchInput: null },
	});
}

async function handleProcessState(deps: WsDeps, frame: ProcessStateFrame): Promise<void> {
	const row = await deps.store.getWorkspace(frame.workspace_id);
	if (!row || isTerminal(row.state) || row.state === "preserving") return;
	if (frame.payload.phase === "running") {
		await maybeMarkReady(deps, row, row.health, row.networkState);
		return;
	}
	if (frame.payload.phase !== "exited") return;
	const now = new Date();
	if (row.state === "terminating") {
		await deps.scheduler.finalize(
			row,
			(row.terminalIntent ?? "failed") as WorkspaceState,
			row.reasonCode,
			now,
		);
		return;
	}
	await deps.scheduler.handleProcessExit(row, frame.payload.exit_code ?? null, now);
}

async function handleAgentState(deps: WsDeps, frame: AgentStateFrame): Promise<void> {
	const row = await deps.store.getWorkspace(frame.workspace_id);
	if (!row || isTerminal(row.state) || row.agentState === frame.payload.state) return;
	const now = new Date();
	await deps.store.updateWorkspace(
		row.id,
		{
			agentState: frame.payload.state,
			...(frame.payload.state === "running" ? { lastActivityAt: now } : {}),
		},
		now,
	);
}

async function handleNetworkState(deps: WsDeps, frame: NetworkStateFrame): Promise<void> {
	const row = await deps.store.getWorkspace(frame.workspace_id);
	if (!row || isTerminal(row.state)) return;
	await deps.store.updateWorkspace(row.id, { networkState: frame.payload.state }, new Date());
	if (frame.payload.state === "degraded") {
		await deps.scheduler.finalize(row, "failed", "network_policy_failed", new Date());
		return;
	}
}

async function handleConnectedFrame(
	deps: WsDeps,
	connection: LiveConnection,
	ws: WSContext,
	frame: AgentFrame,
	closeProtocol: CloseProtocol,
): Promise<void> {
	switch (frame.type) {
		case "registered":
			closeProtocol(ws, "already registered");
			return;
		case "heartbeat":
			if (frame.payload.agentapi_state === "running") {
				await deps.store.updateWorkspace(
					frame.workspace_id,
					{ lastActivityAt: new Date() },
					new Date(),
				);
			}
			return;
		case "service_health":
			await handleServiceHealth(deps, frame);
			return;
		case "agent_state":
			await handleAgentState(deps, frame);
			return;
		case "network_state":
			await handleNetworkState(deps, frame);
			return;
		case "log_chunk":
			await deps.store.appendLogs(frame.workspace_id, [
				{
					stream: frame.payload.stream,
					occurredAt: new Date(frame.payload.occurred_at),
					content: Uint8Array.from(Buffer.from(frame.payload.content_b64, "base64")),
				},
			]);
			return;
		case "process_state":
			await handleProcessState(deps, frame);
			return;
		case "proxy_response":
			deps.hub.resolveRelay(connection, frame.payload);
			return;
		case "proxy_stream_start":
			if (connection.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
				closeProtocol(ws, "stream frame requires protocol v5");
				return;
			}
			deps.hub.startRelayStream(connection, frame.payload);
			return;
		case "proxy_stream_chunk":
			if (connection.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
				closeProtocol(ws, "stream frame requires protocol v5");
				return;
			}
			deps.hub.pushRelayStreamChunk(connection, frame.payload);
			return;
		case "proxy_stream_end":
			if (connection.protocolVersion < STREAMING_MIN_PROTOCOL_VERSION) {
				closeProtocol(ws, "stream frame requires protocol v5");
				return;
			}
			deps.hub.endRelayStream(connection, frame.payload);
			return;
		case "terminal_opened":
			if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
				closeProtocol(ws, "terminal frame requires protocol v4");
				return;
			}
			deps.hub.terminalOpened(connection, frame.payload);
			return;
		case "terminal_output":
			if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
				closeProtocol(ws, "terminal frame requires protocol v4");
				return;
			}
			deps.hub.terminalOutput(connection, frame.payload);
			return;
		case "terminal_closed":
			if (connection.protocolVersion < TERMINAL_MIN_PROTOCOL_VERSION) {
				closeProtocol(ws, "terminal frame requires protocol v4");
				return;
			}
			deps.hub.terminalClosed(connection, frame.payload);
			return;
		case "termination_ack":
			return;
		case "source_resolved":
			await deps.persistence?.sourceResolved(frame.workspace_id, {
				kind: "git",
				...frame.payload,
			});
			return;
		case "checkpoint_status":
			deps.hub.resolveCheckpoint(connection, frame.payload.operation_id, frame.payload.phase);
			return;
		case "attachment_ack":
			deps.hub.pushAttachment(connection, { kind: "ack", payload: frame.payload });
			return;
		case "attachment_result":
			deps.hub.pushAttachment(connection, { kind: "result", payload: frame.payload });
			return;
		case "attachment_resolved":
			deps.hub.pushAttachment(connection, { kind: "resolved", payload: frame.payload });
			return;
		case "output_published":
			await deps.persistence?.publishOutput(
				frame.workspace_id,
				frame.payload.name,
				frame.payload.value,
			);
			return;
		case "restore_status":
			return;
		case "conversation_message": {
			const workspace = await deps.store.getWorkspace(frame.workspace_id);
			if (!workspace || isTerminal(workspace.state)) return;
			try {
				await deps.store.appendConversationMessage({
					workspaceId: frame.workspace_id,
					messageId: frame.payload.message_id,
					role: frame.payload.role,
					content: frame.payload.content,
					occurredAt: new Date(frame.payload.occurred_at),
					metadata: frame.payload.metadata,
					createdAt: new Date(),
				});
			} catch (error) {
				deps.log?.(`conversation ${frame.workspace_id}: ${String(error)}`);
			}
			return;
		}
	}
}

function parseFrame(
	data: string | ArrayBuffer | Uint8Array,
	auth: WsAuth,
	connection: LiveConnection | null,
	ws: WSContext,
	closeProtocol: CloseProtocol,
): AgentFrame | null {
	const raw = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
	if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
		closeProtocol(ws, "frame too large");
		return null;
	}
	const parsed = AgentFrameSchema.safeParse(JSON.parse(raw));
	if (!parsed.success) {
		closeProtocol(ws, "invalid frame");
		return null;
	}
	const frame = parsed.data;
	if (frame.v !== auth.protocolVersion) {
		closeProtocol(ws, "wrong protocol version");
		return null;
	}
	if (frame.workspace_id !== auth.workspaceId) {
		closeProtocol(ws, "wrong workspace");
		return null;
	}
	if (!connection) {
		if (frame.type !== "registered") closeProtocol(ws, "not registered");
		return frame.type === "registered" ? frame : null;
	}
	if (frame.connection_id !== connection.connectionId) {
		closeProtocol(ws, "wrong connection");
		return null;
	}
	if (frame.seq <= connection.lastSeqIn) {
		closeProtocol(ws, "sequence violation");
		return null;
	}
	return frame;
}

async function processMessage(
	deps: WsDeps,
	auth: WsAuth,
	connection: LiveConnection | null,
	data: string | ArrayBuffer | Uint8Array,
	ws: WSContext,
	closeProtocol: CloseProtocol,
): Promise<LiveConnection | null> {
	const frame = parseFrame(data, auth, connection, ws, closeProtocol);
	if (!frame) return connection;
	if (!connection) {
		return await registerConnection(deps, auth, ws, frame as RegisteredFrame, closeProtocol);
	}
	connection.lastSeqIn = frame.seq;
	await handleConnectedFrame(deps, connection, ws, frame, closeProtocol);
	return connection;
}

async function detachConnection(
	deps: WsDeps,
	auth: WsAuth,
	connection: LiveConnection | null,
): Promise<void> {
	if (!connection) return;
	const wasLive = deps.hub.detach(connection);
	connection.registered = false;
	if (!wasLive) return;
	const row = await deps.store.getWorkspace(auth.workspaceId);
	if (row && !isTerminal(row.state) && !["terminating", "preserving"].includes(row.state)) {
		await deps.store.updateWorkspace(row.id, { disconnectedAt: new Date() }, new Date());
	}
}

// Frames are processed strictly in arrival order; concurrent handling would
// race log sequencing and state transitions.
export function agentWsEvents(deps: WsDeps) {
	return (c: { get: (key: string) => unknown }): WSEvents => {
		const auth = c.get("wsAuth") as WsAuth;
		let conn: LiveConnection | null = null;
		let pipeline: Promise<void> = Promise.resolve();

		const closeProtocol = (ws: WSContext, message: string) => {
			deps.log?.(`ws ${auth.workspaceId}: protocol error: ${message}`);
			ws.close(1008, message);
		};

		return {
			onMessage: (event, ws) => {
				pipeline = pipeline.then(async () => {
					try {
						conn = await processMessage(
							deps,
							auth,
							conn,
							event.data as string | ArrayBuffer | Uint8Array,
							ws,
							closeProtocol,
						);
					} catch (err) {
						deps.log?.(`ws ${auth.workspaceId}: ${String(err)}`);
						closeProtocol(ws, "internal error");
					}
				});
			},
			onClose: () => {
				void detachConnection(deps, auth, conn);
			},
		};
	};
}
