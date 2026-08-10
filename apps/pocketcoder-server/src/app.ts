import { OpenAPIHono } from "@hono/zod-openapi";
import {
	digestOpaque,
	generateOpaqueSecret,
	verifyEgressAuditToken,
} from "@pstdio/pocketcoder-auth";
import {
	ApiError,
	NetworkEventBatchSchema,
	type TerminalClosed,
	type TerminalCloseReason,
} from "@pstdio/pocketcoder-contracts";
import {
	type AdmissionLimits,
	type MetricSink,
	type ResolvedWarmPool,
	RuntimeMetrics,
	Scheduler,
	type Store,
	WarmPoolManager,
	type WorkspaceDriver,
	type WorkspaceSecretResolver,
	type WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import type { ServerWebSocket } from "bun";
import { createBunWebSocket } from "hono/bun";
import { agentMessageBodyTransform, attachmentUploadHandler } from "./attachments";
import { Readiness } from "./health";
import { Hub } from "./hub";
import {
	type AppEnv,
	errorHandler,
	machineAuth,
	requestId,
	requestLogging,
	requireScope,
} from "./middleware";
import { createStructuredLogger, type StructuredLogger } from "./observability";
import { type PersistenceLimits, PersistenceService } from "./persistence";
import { PoolConnectionHub, poolConnectValidator, poolWsEvents } from "./pool-ws";
import { relayHandler } from "./relay";
import { registerAdministrationRoutes } from "./routes/administration";
import { registerCatalogRoutes } from "./routes/catalog";
import { registerCheckpointRoutes } from "./routes/checkpoints";
import { registerConversationRoutes } from "./routes/conversations";
import { registerDiagnosticRoutes } from "./routes/diagnostics";
import { registerRecoveryRoutes } from "./routes/recovery";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { WorkspaceService } from "./service";
import type { TerminalBridgeCallbacks } from "./terminal-bridge";
import { terminalConnectValidator, terminalWsEvents } from "./terminal-ws";
import { agentConnectValidator, agentWsEvents } from "./ws";

export interface BuildDeps {
	store: Store;
	driver: WorkspaceDriver & { cleanupInput?(workspaceId: string): Promise<void> };
	storageDriver?: WorkspaceStorageDriver;
	secretResolver?: WorkspaceSecretResolver;
	persistenceLimits?: PersistenceLimits;
	pepper: string;
	eventSigningKey?: string;
	limits: AdmissionLimits;
	workspaceServerUrl: string;
	instanceId?: string;
	logger?: StructuredLogger;
	metrics?: MetricSink;
	warmPools?: ResolvedWarmPool[];
	readiness?: Readiness;
}

export interface BuiltServer {
	app: OpenAPIHono<AppEnv>;
	websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
	hub: Hub;
	scheduler: Scheduler;
	service: WorkspaceService;
	persistence: PersistenceService;
	warmPool?: WarmPoolManager;
	metrics: MetricSink;
}

function terminalAuditReason(reason: TerminalClosed["reason"]): TerminalCloseReason {
	if (reason === "error") return "agent_detached";
	if (reason === "closed") return "client_closed";
	return reason;
}

function terminalCallbacks(store: Store): TerminalBridgeCallbacks {
	return {
		onTerminalInput: (workspaceId) => {
			const now = new Date();
			return store.updateWorkspace(workspaceId, { lastActivityAt: now }, now);
		},
		onTerminalClosed: async (event) => {
			const closedAt = new Date();
			const closeReason = terminalAuditReason(event.reason);
			const session = await store.closeTerminalSession(event.session_id, {
				closedAt,
				closeReason,
				exitCode: event.exit_code ?? null,
				bytesIn: event.bytesIn,
				bytesOut: event.bytesOut,
			});
			if (!session) return;
			await store.appendEvent(
				event.workspaceId,
				"workspace.terminal_closed",
				{
					session_id: session.sessionId,
					close_reason: session.closeReason,
					exit_code: session.exitCode,
					duration_ms: closedAt.getTime() - session.openedAt.getTime(),
					bytes_in: session.bytesIn,
					bytes_out: session.bytesOut,
				},
				closedAt,
			);
		},
	};
}

function workspaceSecretFactory(pepper: string) {
	return {
		generate: generateOpaqueSecret,
		digest: (secret: string) => digestOpaque(pepper, secret),
	};
}

export function buildServer(deps: BuildDeps): BuiltServer {
	const { store, driver, pepper, limits } = deps;
	const logger = deps.logger ?? createStructuredLogger(() => {});
	const metrics = deps.metrics ?? new RuntimeMetrics();
	const log = (message: string) => logger.info("runtime.message", { message });
	const hub = new Hub(terminalCallbacks(store));
	const poolHub = new PoolConnectionHub();
	const secretFactory = workspaceSecretFactory(pepper);
	const warmPool = deps.warmPools
		? new WarmPoolManager({
				store,
				driver,
				connections: poolHub,
				secrets: secretFactory,
				workspaceServerUrl: deps.workspaceServerUrl,
				pools: deps.warmPools,
				onError: (context, error) => log(`${context}: ${String(error)}`),
			})
		: undefined;
	const persistenceHolder: { service?: PersistenceService } = {};
	const scheduler = new Scheduler({
		store,
		driver,
		...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
		...(deps.secretResolver ? { secretResolver: deps.secretResolver } : {}),
		connections: hub,
		secrets: secretFactory,
		limits,
		workspaceServerUrl: deps.workspaceServerUrl,
		metrics,
		...(warmPool ? { warmPool } : {}),
		preserveByPolicy: async (row, trigger) =>
			persistenceHolder.service?.preserveByPolicy(row, trigger) ?? false,
		onError: (context, err) => log(`scheduler ${context}: ${String(err)}`),
	});
	const service = new WorkspaceService({ store, scheduler, limits });
	const persistence = new PersistenceService({
		store,
		scheduler,
		driver,
		...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
		hub,
		workspaces: service,
		maxQueuedWorkspaces: limits.maxQueuedWorkspaces,
		log,
		...(deps.persistenceLimits ? { limits: deps.persistenceLimits } : {}),
	});
	persistenceHolder.service = persistence;

	const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

	const app = new OpenAPIHono<AppEnv>({
		defaultHook: (result) => {
			if (!result.success) {
				const issue = result.error.issues[0];
				if (issue?.path.some((segment) => String(segment).toLowerCase() === "idempotency-key")) {
					throw new ApiError("validation.invalid", "Idempotency-Key header is required.");
				}
				throw new ApiError(
					"validation.invalid",
					issue ? `${issue.path.join(".") || "request"}: ${issue.message}` : "Invalid request.",
				);
			}
		},
	});
	app.onError(errorHandler(logger));
	app.use("*", requestId);
	app.use("*", requestLogging(logger));

	const readiness = deps.readiness ?? new Readiness();
	app.get("/livez", (c) =>
		c.json({
			ok: true,
			...(deps.instanceId ? { instance_id: deps.instanceId } : {}),
		}),
	);
	app.get("/readyz", (c) => {
		const snapshot = readiness.snapshot();
		return c.json(
			{
				...snapshot,
				...(deps.instanceId ? { instance_id: deps.instanceId } : {}),
			},
			snapshot.ok ? 200 : 503,
		);
	});

	// Agent supervisor connection; authenticated by registration/reconnect
	// credentials, not machine keys, so it is registered before machineAuth.
	const wsDeps = {
		store,
		hub,
		scheduler,
		pepper,
		...(deps.secretResolver ? { secretResolver: deps.secretResolver } : {}),
		...(driver.cleanupInput
			? { cleanupInput: (id: string) => driver.cleanupInput?.(id) ?? Promise.resolve() }
			: {}),
		log,
		persistence,
	};
	app.get(
		"/v1/agent/connect",
		agentConnectValidator(wsDeps),
		upgradeWebSocket(agentWsEvents(wsDeps)),
	);
	if (warmPool) {
		app.get(
			"/v1/agent/pool-connect",
			poolConnectValidator({ store, pepper }),
			upgradeWebSocket(poolWsEvents({ store, hub: poolHub, manager: warmPool, log })),
		);
	}
	app.post("/v1/internal/egress/events", async (c) => {
		const authorization = c.req.header("authorization") ?? "";
		const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		const subject = verifyEgressAuditToken(deps.eventSigningKey ?? pepper, token);
		if (!subject) return c.json({ error: "invalid_audit_token" }, 401);
		const raw = await c.req.text();
		if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return c.json({ error: "batch_too_large" }, 413);
		let body: unknown = null;
		try {
			body = JSON.parse(raw);
		} catch {
			// Stable invalid_batch response below.
		}
		const parsed = NetworkEventBatchSchema.safeParse(body);
		if (!parsed.success) return c.json({ error: "invalid_batch" }, 400);
		const workspaceId =
			subject.kind === "workspace"
				? subject.id
				: (await store.getWarmPoolRuntime(subject.id))?.workspaceId;
		if (!workspaceId || !(await store.getWorkspace(workspaceId))) {
			return c.json({ error: "audit_subject_unassigned" }, 409);
		}
		await store.appendNetworkEvents(workspaceId, parsed.data.source_session_id, parsed.data.events);
		return c.json({ accepted: parsed.data.events.length }, 202);
	});

	// The generated OpenAPI document is served without machine auth so
	// tooling can consume the contract; it contains no secrets.
	app.doc("/v1/openapi.json", {
		openapi: "3.0.0",
		info: {
			title: "pocketcoder",
			version: "0.1.0",
			description: "MIT-licensed control plane for coding agents in isolated workspaces.",
		},
	});

	app.use("/v1/*", machineAuth(store, pepper));

	registerCatalogRoutes({ app, store });
	registerAdministrationRoutes({ app, persistence, warmPool });
	registerCheckpointRoutes({ app, store, service, persistence });
	registerRecoveryRoutes({ app, store, service, persistence });
	registerConversationRoutes({ app, store, service });
	registerWorkspaceRoutes({ app, store, service });
	registerDiagnosticRoutes({ app, store, service });
	const terminalDeps = { store, hub, service };
	app.get(
		"/v1/workspaces/:id/terminal",
		requireScope("terminal:attach"),
		terminalConnectValidator(terminalDeps),
		upgradeWebSocket(terminalWsEvents(terminalDeps)),
	);

	// --- Templates ---

	// --- Workspace attachments ---

	const relayDeps = { store, hub, service };
	app.put(
		"/v1/workspaces/:id/attachments/:attachmentId",
		requireScope("attachments:write"),
		attachmentUploadHandler(relayDeps),
	);

	// --- Workspace service relay ---

	// The AgentAPI message aliases are registered before the wildcard relay
	// routes so attachment references resolve on both spellings.
	const messageTransform = agentMessageBodyTransform(relayDeps);
	app.post(
		"/v1/workspaces/:id/agent/message",
		requireScope("services:relay"),
		relayHandler(relayDeps, {
			service: "agent",
			pathPrefix: (id) => `/v1/workspaces/${id}/agent`,
			transformBodyB64: messageTransform,
		}),
	);
	app.post(
		"/v1/workspaces/:id/services/agent/message",
		requireScope("services:relay"),
		relayHandler(relayDeps, {
			service: "agent",
			pathPrefix: (id) => `/v1/workspaces/${id}/services/agent`,
			transformBodyB64: messageTransform,
		}),
	);
	app.on(
		["GET", "POST", "PUT", "PATCH", "DELETE"],
		"/v1/workspaces/:id/services/:service/*",
		requireScope("services:relay"),
		relayHandler(relayDeps),
	);
	app.on(
		["GET", "POST"],
		"/v1/workspaces/:id/agent/*",
		requireScope("services:relay"),
		relayHandler(relayDeps, {
			service: "agent",
			pathPrefix: (id) => `/v1/workspaces/${id}/agent`,
		}),
	);

	return {
		app,
		websocket,
		hub,
		scheduler,
		service,
		persistence,
		metrics,
		...(warmPool ? { warmPool } : {}),
	};
}
