import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	ApiError,
	CheckpointListQuerySchema,
	CheckpointPageSchema,
	CheckpointResourceSchema,
	OperationResourceSchema,
	PreserveRequestSchema,
	RestoreRequestSchema,
	WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../middleware";
import { decodeStringCursor, encodeCursor } from "../pagination";
import { type PersistenceService, toCheckpointResource, toOperationResource } from "../persistence";
import { toResource, type WorkspaceService } from "../service";
import { COMMON_ERROR_RESPONSES, IdempotencyHeadersSchema } from "./shared";

function checkpointCursor(row: { id: string; createdAt: Date }) {
	return `${row.createdAt.toISOString()}\\0${row.id}`;
}

interface CheckpointRouteDeps {
	app: OpenAPIHono<AppEnv>;
	store: Store;
	service: WorkspaceService;
	persistence: PersistenceService;
}

function registerPreserveRoute({ app, store, service, persistence }: CheckpointRouteDeps) {
	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces/{id}/preserve",
			operationId: "preserveWorkspace",
			tags: ["Checkpoints"],
			middleware: [requireScope("workspaces:preserve")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: IdempotencyHeadersSchema,
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
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const result = await persistence.preserve(
				principal,
				id,
				c.req.valid("json"),
				c.req.valid("header")["Idempotency-Key"],
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
}

export function registerCheckpointRoutes(deps: CheckpointRouteDeps) {
	const { app, store, service, persistence } = deps;
	registerPreserveRoute(deps);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/operations/{id}",
			operationId: "getOperation",
			tags: ["Operations"],
			middleware: [requireScope("workspaces:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Durable persistence operation",
					content: { "application/json": { schema: OperationResourceSchema } },
				},
				...COMMON_ERROR_RESPONSES,
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
			operationId: "listWorkspaceCheckpoints",
			tags: ["Checkpoints"],
			middleware: [requireScope("checkpoints:read")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				query: CheckpointListQuerySchema,
			},
			responses: {
				200: {
					description: "Principal-owned checkpoints for a workspace",
					content: {
						"application/json": {
							schema: CheckpointPageSchema,
						},
					},
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			await service.getOwned(principal, id);
			const { state, cursor, limit } = c.req.valid("query");
			const after = decodeStringCursor("checkpoints", cursor);
			const rows = (
				await store.listCheckpoints(principal.id, {
					workspaceId: id,
					...(state ? { state } : {}),
				})
			).toSorted((left, right) => checkpointCursor(right).localeCompare(checkpointCursor(left)));
			const remaining = after ? rows.filter((row) => checkpointCursor(row) < after) : rows;
			const hasMore = remaining.length > limit;
			const items = remaining.slice(0, limit);
			const last = items.at(-1);
			return c.json(
				{
					items: items.map(toCheckpointResource),
					next_cursor: hasMore && last ? encodeCursor("checkpoints", checkpointCursor(last)) : null,
				},
				200,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/checkpoints/{id}",
			operationId: "getCheckpoint",
			tags: ["Checkpoints"],
			middleware: [requireScope("checkpoints:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Checkpoint resource",
					content: { "application/json": { schema: CheckpointResourceSchema } },
				},
				...COMMON_ERROR_RESPONSES,
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
			operationId: "verifyCheckpoint",
			tags: ["Checkpoints"],
			middleware: [requireScope("checkpoints:read")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: IdempotencyHeadersSchema,
			},
			responses: {
				202: {
					description: "Checkpoint verification result",
					content: { "application/json": { schema: OperationResourceSchema } },
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const operation = await persistence.verify(
				c.get("principal"),
				c.req.valid("param").id,
				c.req.valid("header")["Idempotency-Key"],
			);
			return c.json(toOperationResource(operation), 202);
		},
	);

	app.openapi(
		createRoute({
			method: "delete",
			path: "/v1/checkpoints/{id}",
			operationId: "deleteCheckpoint",
			tags: ["Checkpoints"],
			middleware: [requireScope("checkpoints:delete")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: IdempotencyHeadersSchema,
			},
			responses: {
				202: {
					description: "Checkpoint deletion operation",
					content: { "application/json": { schema: OperationResourceSchema } },
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const operation = await persistence.delete(
				c.get("principal"),
				c.req.valid("param").id,
				c.req.valid("header")["Idempotency-Key"],
			);
			return c.json(toOperationResource(operation), 202);
		},
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/checkpoints/{id}/restore",
			operationId: "restoreCheckpoint",
			tags: ["Checkpoints"],
			middleware: [requireScope("workspaces:restore")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: IdempotencyHeadersSchema,
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
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const result = await persistence.restore(
				principal,
				c.req.valid("param").id,
				c.req.valid("json"),
				c.req.valid("header")["Idempotency-Key"],
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
}
