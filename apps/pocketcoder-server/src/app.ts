import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { digestOpaque, generateOpaqueSecret } from "@pstdio/pocketcoder-auth";
import {
	ApiError,
	CHECKPOINT_STATES,
	CheckpointResourceSchema,
	OperationResourceSchema,
	PreserveRequestSchema,
	RestoreRequestSchema,
	TemplateListItemSchema,
	WorkspaceCreateRequestSchema,
	WorkspaceListQuerySchema,
	WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import {
	type AdmissionLimits,
	Scheduler,
	type Store,
	type TemplateRow,
	type WorkspaceDriver,
	type WorkspaceSecretResolver,
	type WorkspaceStorageDriver,
} from "@pstdio/pocketcoder-runtime-core";
import type { ServerWebSocket } from "bun";
import { createBunWebSocket } from "hono/bun";
import { Hub } from "./hub";
import { type AppEnv, handleError, machineAuth, requestId, requireScope } from "./middleware";
import {
	type PersistenceLimits,
	PersistenceService,
	toCheckpointResource,
	toOperationResource,
} from "./persistence";
import { relayHandler } from "./relay";
import { templateAuthorized, toResource, WorkspaceService } from "./service";
import { agentConnectValidator, agentWsEvents } from "./ws";

export interface BuildDeps {
	store: Store;
	driver: WorkspaceDriver & { cleanupInput?(workspaceId: string): Promise<void> };
	storageDriver?: WorkspaceStorageDriver;
	secretResolver?: WorkspaceSecretResolver;
	persistenceLimits?: PersistenceLimits;
	pepper: string;
	limits: AdmissionLimits;
	workspaceServerUrl: string;
	instanceId?: string;
	log?: (msg: string) => void;
}

export interface BuiltServer {
	app: OpenAPIHono<AppEnv>;
	websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>["websocket"];
	hub: Hub;
	scheduler: Scheduler;
	service: WorkspaceService;
	persistence: PersistenceService;
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

const WorkspaceCreateHeadersSchema = z.object({
	"Idempotency-Key": z.string().min(1).max(256).openapi({
		description:
			"Opaque caller key. Reusing it with the same request returns the original workspace; a different request returns idempotency.conflict.",
		example: "onefin-task-018f6f0e",
	}),
});

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: OpenAPI route declarations stay together so middleware, schemas, and handlers remain auditable.
export function buildServer(deps: BuildDeps): BuiltServer {
	const { store, driver, pepper, limits, log } = deps;
	const hub = new Hub();
	const persistenceHolder: { service?: PersistenceService } = {};
	const scheduler = new Scheduler({
		store,
		driver,
		...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
		...(deps.secretResolver ? { secretResolver: deps.secretResolver } : {}),
		connections: hub,
		secrets: {
			generate: generateOpaqueSecret,
			digest: (secret) => digestOpaque(pepper, secret),
		},
		limits,
		workspaceServerUrl: deps.workspaceServerUrl,
		preserveByPolicy: async (row, trigger) =>
			persistenceHolder.service?.preserveByPolicy(row, trigger) ?? false,
		onError: (context, err) => log?.(`scheduler ${context}: ${String(err)}`),
	});
	const service = new WorkspaceService({ store, scheduler, limits });
	const persistence = new PersistenceService({
		store,
		scheduler,
		driver,
		...(deps.storageDriver ? { storageDriver: deps.storageDriver } : {}),
		hub,
		workspaces: service,
		...(log ? { log } : {}),
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
	app.onError(handleError);
	app.use("*", requestId);

	app.get("/healthz", (c) =>
		c.json({
			ok: true,
			...(deps.instanceId ? { instance_id: deps.instanceId } : {}),
		}),
	);

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
		persistence,
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
			path: "/v1/storage/inventory",
			middleware: [requireScope("admin")] as const,
			responses: {
				200: {
					description: "Physical storage inventory without backend paths",
					content: {
						"application/json": {
							schema: z.object({
								backend: z.string(),
								storage_count: z.number(),
								checkpoint_count: z.number(),
								unknown_storage: z.array(z.string()),
								unknown_checkpoints: z.array(z.string()),
							}),
						},
					},
				},
			},
		}),
		async (c) => c.json(await persistence.storageInventory(), 200),
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/storage/prune",
			middleware: [requireScope("admin")] as const,
			responses: {
				200: {
					description: "Delete expired ready checkpoints through durable delete operations",
					content: {
						"application/json": {
							schema: z.object({
								deleted: z.number(),
								skipped: z.number(),
							}),
						},
					},
				},
			},
		}),
		async (c) => c.json(await persistence.pruneExpired(), 200),
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces/{id}/preserve",
			middleware: [requireScope("workspaces:preserve")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: z.object({ "idempotency-key": z.string().min(1).max(256) }),
				body: { content: { "application/json": { schema: PreserveRequestSchema } } },
			},
			responses: {
				202: {
					description: "Durable preserve operation accepted",
					content: {
						"application/json": {
							schema: z.object({
								workspace: WorkspaceResourceSchema,
								checkpoint: CheckpointResourceSchema,
								operation: OperationResourceSchema,
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const result = await persistence.preserve(
				principal,
				id,
				c.req.valid("json"),
				c.req.valid("header")["idempotency-key"],
			);
			const [workspace, checkpoint, operation] = await Promise.all([
				service.getOwned(principal, result.workspaceId),
				store.getCheckpoint(result.checkpoint.id),
				store.getOperation(result.operation.id),
			]);
			return c.json(
				{
					workspace: toResource(workspace),
					checkpoint: toCheckpointResource(checkpoint ?? result.checkpoint),
					operation: toOperationResource(operation ?? result.operation),
				},
				202,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/operations/{id}",
			middleware: [requireScope("workspaces:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Durable persistence operation",
					content: { "application/json": { schema: OperationResourceSchema } },
				},
			},
		}),
		async (c) => {
			const row = await store.getOperation(c.req.valid("param").id);
			if (!row || row.principalId !== c.get("principal").id) {
				throw new ApiError("workspace.not_found", "Unknown operation.");
			}
			return c.json(toOperationResource(row), 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/workspaces/{id}/checkpoints",
			middleware: [requireScope("checkpoints:read")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				query: z.object({ state: z.enum(CHECKPOINT_STATES).optional() }),
			},
			responses: {
				200: {
					description: "Principal-owned checkpoints for a workspace",
					content: {
						"application/json": {
							schema: z.object({ items: z.array(CheckpointResourceSchema) }),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			await service.getOwned(principal, id);
			const state = c.req.valid("query").state;
			const items = await store.listCheckpoints(principal.id, {
				workspaceId: id,
				...(state ? { state } : {}),
			});
			return c.json({ items: items.map(toCheckpointResource) }, 200);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/checkpoints/{id}",
			middleware: [requireScope("checkpoints:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Checkpoint resource",
					content: { "application/json": { schema: CheckpointResourceSchema } },
				},
			},
		}),
		async (c) => {
			const row = await persistence.getCheckpointOwned(c.get("principal"), c.req.valid("param").id);
			return c.json(toCheckpointResource(row), 200);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/checkpoints/{id}/verify",
			middleware: [requireScope("checkpoints:read")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: z.object({ "idempotency-key": z.string().min(1).max(256) }),
			},
			responses: {
				202: {
					description: "Checkpoint verification result",
					content: { "application/json": { schema: OperationResourceSchema } },
				},
			},
		}),
		async (c) => {
			const operation = await persistence.verify(
				c.get("principal"),
				c.req.valid("param").id,
				c.req.valid("header")["idempotency-key"],
			);
			return c.json(toOperationResource(operation), 202);
		},
	);

	app.openapi(
		createRoute({
			method: "delete",
			path: "/v1/checkpoints/{id}",
			middleware: [requireScope("checkpoints:delete")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: z.object({ "idempotency-key": z.string().min(1).max(256) }),
			},
			responses: {
				202: {
					description: "Checkpoint deletion operation",
					content: { "application/json": { schema: OperationResourceSchema } },
				},
			},
		}),
		async (c) => {
			const operation = await persistence.delete(
				c.get("principal"),
				c.req.valid("param").id,
				c.req.valid("header")["idempotency-key"],
			);
			return c.json(toOperationResource(operation), 202);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/checkpoints/{id}/restore",
			middleware: [requireScope("workspaces:restore")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: z.object({ "idempotency-key": z.string().min(1).max(256) }),
				body: { content: { "application/json": { schema: RestoreRequestSchema } } },
			},
			responses: {
				202: {
					description: "New workspace queued from immutable checkpoint",
					content: {
						"application/json": {
							schema: z.object({
								workspace: WorkspaceResourceSchema,
								operation: OperationResourceSchema,
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const result = await persistence.restore(
				principal,
				c.req.valid("param").id,
				c.req.valid("json"),
				c.req.valid("header")["idempotency-key"],
			);
			const workspace = await service.getOwned(principal, result.workspaceId);
			return c.json(
				{
					workspace: toResource(workspace),
					operation: toOperationResource(result.operation),
				},
				202,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces/{id}/recreate",
			middleware: [requireScope("workspaces:restore")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: z.object({ "idempotency-key": z.string().min(1).max(256) }),
				body: { content: { "application/json": { schema: RestoreRequestSchema } } },
			},
			responses: {
				202: {
					description: "New workspace queued from latest checkpoint",
					content: {
						"application/json": {
							schema: z.object({
								workspace: WorkspaceResourceSchema,
								operation: OperationResourceSchema,
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const source = await service.getOwned(principal, c.req.valid("param").id);
			const checkpoints = await store.listCheckpoints(principal.id, {
				workspaceId: source.id,
				state: "ready",
			});
			const checkpoint = checkpoints[0];
			if (!checkpoint) {
				throw new ApiError("checkpoint.none_ready", "Workspace has no ready checkpoint.");
			}
			const result = await persistence.restore(
				principal,
				checkpoint.id,
				c.req.valid("json"),
				c.req.valid("header")["idempotency-key"],
			);
			const workspace = await service.getOwned(principal, result.workspaceId);
			return c.json(
				{
					workspace: toResource(workspace),
					operation: toOperationResource(result.operation),
				},
				202,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/workspaces/{id}/outputs",
			middleware: [requireScope("outputs:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Append-only workspace outputs",
					content: {
						"application/json": {
							schema: z.object({
								items: z.array(
									z.object({
										seq: z.number(),
										name: z.string(),
										value: z.unknown(),
										occurred_at: z.string(),
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
			await service.getOwned(principal, id);
			const rows = await store.listOutputs(id);
			return c.json(
				{
					items: rows.map((row) => ({
						seq: row.seq,
						name: row.name,
						value: row.value,
						occurred_at: row.occurredAt.toISOString(),
					})),
				},
				200,
			);
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
				headers: WorkspaceCreateHeadersSchema,
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
			const idempotencyKey = c.req.valid("header")["Idempotency-Key"];
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
			method: "get",
			path: "/v1/workspaces/{id}/changes",
			middleware: [requireScope("workspaces:read")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				query: z.object({
					after: z.coerce.number().int().nonnegative().default(0),
					wait: z.coerce.number().int().min(0).max(30).default(0),
				}),
			},
			responses: {
				200: {
					description:
						"Current workspace resource, returned after a newer durable change or the bounded wait",
					content: {
						"application/json": {
							schema: z.object({
								cursor: z.number().int().nonnegative(),
								changed: z.boolean(),
								workspace: WorkspaceResourceSchema,
							}),
						},
					},
				},
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const { after, wait } = c.req.valid("query");
			const result = await service.waitForChange(principal, id, after, wait, c.req.raw.signal);
			return c.json(
				{
					cursor: result.workspace.changeSeq,
					changed: result.changed,
					workspace: toResource(result.workspace),
				},
				200,
			);
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

	return { app, websocket, hub, scheduler, service, persistence };
}
