import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	ApiError,
	WorkspaceCreateRequestSchema,
	WorkspaceListQuerySchema,
	WorkspacePageSchema,
	WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store, WorkspaceListFilter } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../middleware";
import { decodeStringCursor, encodeCursor } from "../pagination";
import { toResource, type WorkspaceService } from "../service";
import { COMMON_ERROR_RESPONSES, IdempotencyHeadersSchema } from "./shared";

const WorkspaceMetadataFilterSchema = z
	.record(z.string().min(1).max(64), z.string().max(512))
	.refine((value) => Object.keys(value).length <= 16, "metadata filter has at most 16 keys");

function parseMetadataFilter(value: string | undefined): Record<string, string> | undefined {
	if (!value) return undefined;
	try {
		const parsed = WorkspaceMetadataFilterSchema.safeParse(JSON.parse(value));
		if (parsed.success) return parsed.data;
	} catch {
		// Invalid JSON uses the stable validation error below.
	}
	throw new ApiError(
		"validation.invalid",
		"metadata must be a JSON object containing bounded string keys and values.",
	);
}

function workspaceListFilterOf(
	query: z.infer<typeof WorkspaceListQuerySchema>,
): WorkspaceListFilter {
	const metadata = parseMetadataFilter(query.metadata);
	const createdAfter = query.created_after ? new Date(query.created_after) : undefined;
	const createdBefore = query.created_before ? new Date(query.created_before) : undefined;
	if (createdAfter && createdBefore && createdAfter >= createdBefore)
		throw new ApiError("validation.invalid", "created_after must be before created_before.");
	return {
		...(query.external_id ? { externalId: query.external_id } : {}),
		...(query.state ? { state: query.state } : {}),
		...(query.template ? { template: query.template } : {}),
		...(metadata ? { metadata } : {}),
		...(createdAfter ? { createdAfter } : {}),
		...(createdBefore ? { createdBefore } : {}),
		limit: query.limit,
		...(query.cursor ? { cursor: query.cursor } : {}),
	};
}

export function registerWorkspaceRoutes({
	app,
	store,
	service,
}: {
	app: OpenAPIHono<AppEnv>;
	store: Store;
	service: WorkspaceService;
}) {
	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces",
			operationId: "createWorkspace",
			tags: ["Workspaces"],
			middleware: [requireScope("workspaces:create")] as const,
			request: {
				headers: IdempotencyHeadersSchema,
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
				...COMMON_ERROR_RESPONSES,
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
			operationId: "listWorkspaces",
			tags: ["Workspaces"],
			middleware: [requireScope("workspaces:read")] as const,
			request: { query: WorkspaceListQuerySchema },
			responses: {
				200: {
					description: "Principal-scoped workspaces",
					content: {
						"application/json": {
							schema: WorkspacePageSchema,
						},
					},
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const query = c.req.valid("query");
			const cursor = decodeStringCursor("workspaces", query.cursor);
			const rows = await store.listWorkspaces(principal.id, {
				...workspaceListFilterOf({ ...query, cursor }),
				limit: query.limit + 1,
			});
			const hasMore = rows.length > query.limit;
			const items = rows.slice(0, query.limit);
			const last = items[items.length - 1];
			return c.json(
				{
					items: items.map(toResource),
					next_cursor: hasMore && last ? encodeCursor("workspaces", last.id) : null,
				},
				200,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/workspaces/{id}",
			operationId: "getWorkspace",
			tags: ["Workspaces"],
			middleware: [requireScope("workspaces:read")] as const,
			request: { params: z.object({ id: z.uuid() }) },
			responses: {
				200: {
					description: "Workspace resource",
					content: { "application/json": { schema: WorkspaceResourceSchema } },
				},
				...COMMON_ERROR_RESPONSES,
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
			operationId: "getWorkspaceChange",
			tags: ["Workspaces"],
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
				...COMMON_ERROR_RESPONSES,
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
			operationId: "cancelWorkspace",
			tags: ["Workspaces"],
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
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const { id } = c.req.valid("param");
			const row = await service.cancel(principal, id);
			return c.json(toResource(row), 200);
		},
	);
}
