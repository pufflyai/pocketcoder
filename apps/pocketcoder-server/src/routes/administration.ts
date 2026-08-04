import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import {
	StorageInventorySchema,
	StoragePruneResultSchema,
	WarmPoolInventorySchema,
} from "@pstdio/pocketcoder-contracts";
import type { WarmPoolManager } from "@pstdio/pocketcoder-runtime-core";
import type { AppEnv } from "../middleware";
import { requireScope } from "../middleware";
import type { PersistenceService } from "../persistence";
import { COMMON_ERROR_RESPONSES } from "./shared";

export function registerAdministrationRoutes({
	app,
	persistence,
	warmPool,
}: {
	app: OpenAPIHono<AppEnv>;
	persistence: PersistenceService;
	warmPool: WarmPoolManager | undefined;
}) {
	if (warmPool) {
		app.openapi(
			createRoute({
				method: "get",
				path: "/v1/warm-pools",
				operationId: "listWarmPools",
				tags: ["Administration"],
				middleware: [requireScope("admin")] as const,
				responses: {
					200: {
						description: "Warm runtime inventory and cumulative metrics",
						content: {
							"application/json": {
								schema: WarmPoolInventorySchema,
							},
						},
					},
					...COMMON_ERROR_RESPONSES,
				},
			}),
			async (c) => c.json(await warmPool.inventory(), 200),
		);
	}

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/storage/inventory",
			operationId: "getStorageInventory",
			tags: ["Storage"],
			middleware: [requireScope("admin")] as const,
			responses: {
				200: {
					description: "Physical storage inventory without backend paths",
					content: {
						"application/json": {
							schema: StorageInventorySchema,
						},
					},
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => c.json(await persistence.storageInventory(), 200),
	);

	app.openapi(
		createRoute({
			method: "post",
			path: "/v1/storage/prune",
			operationId: "pruneStorage",
			tags: ["Storage"],
			middleware: [requireScope("admin")] as const,
			responses: {
				200: {
					description: "Delete expired ready checkpoints through durable delete operations",
					content: {
						"application/json": {
							schema: StoragePruneResultSchema,
						},
					},
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const result = await persistence.pruneExpired();
			return c.json(
				{
					deleted: result.deleted,
					skipped: result.skipped,
					transcripts_deleted: result.transcriptsDeleted,
				},
				200,
			);
		},
	);
}
