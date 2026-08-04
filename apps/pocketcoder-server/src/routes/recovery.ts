import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	ApiError,
	ConversationResumeOutcomeSchema,
	OperationResourceSchema,
	RestoreRequestSchema,
	WorkspaceResourceSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../middleware";
import { type PersistenceService, toOperationResource } from "../persistence";
import { toResource, type WorkspaceService } from "../service";
import { COMMON_ERROR_RESPONSES, IdempotencyHeadersSchema } from "./shared";

export function registerRecoveryRoutes({
	app,
	store,
	service,
	persistence,
}: {
	app: OpenAPIHono<AppEnv>;
	store: Store;
	service: WorkspaceService;
	persistence: PersistenceService;
}) {
	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces/{id}/recreate",
			operationId: "recreateWorkspace",
			tags: ["Workspaces"],
			middleware: [requireScope("workspaces:restore")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: IdempotencyHeadersSchema,
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
				...COMMON_ERROR_RESPONSES,
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

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/workspaces/{id}/resume",
			operationId: "resumeWorkspace",
			tags: ["Workspaces"],
			middleware: [requireScope("workspaces:restore")] as const,
			request: {
				params: z.object({ id: z.uuid() }),
				headers: IdempotencyHeadersSchema,
				body: { content: { "application/json": { schema: RestoreRequestSchema } } },
			},
			responses: {
				202: {
					description: "New workspace queued with supported conversation context",
					content: {
						"application/json": {
							schema: z.object({
								workspace: WorkspaceResourceSchema,
								operation: OperationResourceSchema,
								resume: ConversationResumeOutcomeSchema,
							}),
						},
					},
				},
				...COMMON_ERROR_RESPONSES,
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
			if (checkpoint.conversationRestore !== "supported") {
				const reason =
					checkpoint.conversationRestore === "filesystem_only"
						? "filesystem_only"
						: "capability_unknown";
				throw new ApiError(
					"resume.unsupported",
					"This checkpoint cannot restore conversation context.",
					{ reason, checkpoint_id: checkpoint.id },
				);
			}
			const result = await persistence.restore(
				principal,
				checkpoint.id,
				c.req.valid("json"),
				c.req.valid("header")["Idempotency-Key"],
			);
			const workspace = await service.getOwned(principal, result.workspaceId);
			return c.json(
				{
					workspace: toResource(workspace),
					operation: toOperationResource(result.operation),
					resume: {
						status: "supported" as const,
						reason: null,
						source_workspace_id: source.id,
						checkpoint_id: checkpoint.id,
					},
				},
				202,
			);
		},
	);
}
