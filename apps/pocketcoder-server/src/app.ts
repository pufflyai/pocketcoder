import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { digestOpaque, generateOpaqueSecret } from "@pocketcoder/auth";
import {
	ApiError,
	TemplateListItemSchema,
	WorkspaceCreateRequestSchema,
	WorkspaceListQuerySchema,
	WorkspaceResourceSchema,
} from "@pocketcoder/contracts";
import {
	type AdmissionLimits,
	Scheduler,
	type Store,
	type TemplateRow,
	type WorkspaceDriver,
} from "@pocketcoder/runtime-core";
import type { ServerWebSocket } from "bun";
import { createBunWebSocket } from "hono/bun";
import { Hub } from "./hub";
import { type AppEnv, handleError, machineAuth, requestId, requireScope } from "./middleware";
import { relayHandler } from "./relay";
import { templateAuthorized, toResource, WorkspaceService } from "./service";
import { agentConnectValidator, agentWsEvents } from "./ws";

export interface BuildDeps {
	store: Store;
	driver: WorkspaceDriver & { cleanupInput?(workspaceId: string): Promise<void> };
	pepper: string;
	limits: AdmissionLimits;
	workspaceServerUrl: string;
	log?: (msg: string) => void;
}

export interface BuiltServer {
	app: OpenAPIHono<AppEnv>;
	websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
	hub: Hub;
	scheduler: Scheduler;
	service: WorkspaceService;
}

function safeTemplateItem(row: TemplateRow) {
	return {
		name: row.name,
		version: row.version,
		digest: row.digest,
		...(row.description ? { description: row.description } : {}),
		status: row.status,
	};
}

export function buildServer(deps: BuildDeps): BuiltServer {
	const { store, driver, pepper, limits, log } = deps;
	const hub = new Hub();
	const scheduler = new Scheduler({
		store,
		driver,
		connections: hub,
		secrets: {
			generate: generateOpaqueSecret,
			digest: (secret) => digestOpaque(pepper, secret),
		},
		limits,
		workspaceServerUrl: deps.workspaceServerUrl,
		onError: (context, err) => log?.(`scheduler ${context}: ${String(err)}`),
	});
	const service = new WorkspaceService({ store, scheduler, limits });

	const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

	const app = new OpenAPIHono<AppEnv>({
		defaultHook: (result) => {
			if (!result.success) {
				const issue = result.error.issues[0];
				throw new ApiError(
					"validation.invalid",
					issue ? `${issue.path.join(".") || "request"}: ${issue.message}` : "Invalid request.",
				);
			}
		},
	});
	app.onError(handleError);
	app.use("*", requestId);

	app.get("/healthz", (c) => c.json({ ok: true }));

	// Agent supervisor connection; authenticated by registration/reconnect
	// credentials, not machine keys, so it is registered before machineAuth.
	const wsDeps = {
		store,
		hub,
		scheduler,
		pepper,
		...(driver.cleanupInput
			? { cleanupInput: (id: string) => driver.cleanupInput?.(id) ?? Promise.resolve() }
			: {}),
		...(log ? { log } : {}),
	};
	app.get(
		"/v1/agent/connect",
		agentConnectValidator(wsDeps),
		upgradeWebSocket(agentWsEvents(wsDeps)),
	);

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

	// --- Templates ---

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/templates",
			middleware: [requireScope("templates:read")] as const,
			responses: {
				200: {
					description: "Authorized template versions",
					content: {
						"application/json": {
							schema: z.object({ items: z.array(TemplateListItemSchema) }),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const names = principal.templateNames.includes("*") ? null : principal.templateNames;
			const rows = await store.listTemplates(names);
			return c.json({ items: rows.map(safeTemplateItem) }, 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/templates/{name}",
			middleware: [requireScope("templates:read")] as const,
			request: { params: z.object({ name: z.string() }) },
			responses: {
				200: {
					description: "Template versions and safe metadata",
					content: {
						"application/json": {
							schema: z.object({
								name: z.string(),
								versions: z.array(TemplateListItemSchema),
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { name } = c.req.valid("param");
			if (!templateAuthorized(principal, name)) {
				throw new ApiError("template.not_found", `Unknown template: ${name}.`);
			}
			const rows = await store.listTemplates([name]);
			if (rows.length === 0) {
				throw new ApiError("template.not_found", `Unknown template: ${name}.`);
			}
			return c.json({ name, versions: rows.map(safeTemplateItem) }, 200);
		},
	);

	// --- Workspaces ---

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces",
			middleware: [requireScope("workspaces:create")] as const,
			request: {
				headers: z.object({ "idempotency-key": z.string().min(1).max(256) }),
				body: {
					content: { "application/json": { schema: WorkspaceCreateRequestSchema } },
				},
			},
			responses: {
				201: {
					description: "Workspace created",
					content: { "application/json": { schema: WorkspaceResourceSchema } },
				},
				200: {
					description: "Existing workspace returned idempotently",
					content: { "application/json": { schema: WorkspaceResourceSchema } },
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const body = c.req.valid("json");
			const idempotencyKey = c.req.valid("header")["idempotency-key"];
			const { workspace, created } = await service.create(principal, body, idempotencyKey);
			return c.json(toResource(workspace), created ? 201 : 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/workspaces",
			middleware: [requireScope("workspaces:read")] as const,
			request: { query: WorkspaceListQuerySchema },
			responses: {
				200: {
					description: "Principal-scoped workspaces",
					content: {
						"application/json": {
							schema: z.object({
								items: z.array(WorkspaceResourceSchema),
								next_cursor: z.string().nullable(),
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const query = c.req.valid("query");
			const rows = await store.listWorkspaces(principal.id, {
				...(query.external_id ? { externalId: query.external_id } : {}),
				...(query.state ? { state: query.state } : {}),
				...(query.template ? { template: query.template } : {}),
				limit: query.limit,
				...(query.cursor ? { cursor: query.cursor } : {}),
			});
			const last = rows[rows.length - 1];
			return c.json(
				{
					items: rows.map(toResource),
					next_cursor: rows.length === query.limit && last ? last.id : null,
				},
				200,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/workspaces/{id}",
			middleware: [requireScope("workspaces:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Workspace resource",
					content: { "application/json": { schema: WorkspaceResourceSchema } },
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const row = await service.getOwned(principal, id);
			return c.json(toResource(row), 200);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces/{id}/cancel",
			middleware: [requireScope("workspaces:cancel")] as const,
			// The optional bounded reason body is read manually; an empty body
			// must stay valid because cancellation is idempotent and minimal.
			request: {
				params: z.object({ id: z.uuid() }),
			},
			responses: {
				200: {
					description: "Current workspace resource after idempotent cancellation",
					content: { "application/json": { schema: WorkspaceResourceSchema } },
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const row = await service.cancel(principal, id);
			return c.json(toResource(row), 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/workspaces/{id}/logs",
			middleware: [requireScope("logs:read")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				query: z.object({
					after: z.coerce.number().int().nonnegative().default(0),
					limit: z.coerce.number().int().positive().max(1000).default(200),
				}),
			},
			responses: {
				200: {
					description: "Bounded operational log chunks",
					content: {
						"application/json": {
							schema: z.object({
								items: z.array(
									z.object({
										seq: z.number(),
										stream: z.string(),
										occurred_at: z.string(),
										content: z.string(),
									}),
								),
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const { after, limit } = c.req.valid("query");
			await service.getOwned(principal, id);
			const logs = await store.readLogs(id, after, limit);
			return c.json(
				{
					items: logs.map((l) => ({
						seq: l.seq,
						stream: l.stream,
						occurred_at: l.occurredAt.toISOString(),
						content: Buffer.from(l.content).toString("utf8"),
					})),
				},
				200,
			);
		},
	);

	// --- Workspace service relay ---

	app.on(
		["GET", "POST", "PUT", "PATCH", "DELETE"],
		"/v1/workspaces/:id/services/:service/*",
		requireScope("services:relay"),
		relayHandler({ store, hub, service }),
	);

	return { app, websocket, hub, scheduler, service };
}
