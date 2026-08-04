import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
	ApiError,
	TemplateListItemSchema,
	TemplateListQuerySchema,
	TemplatePageSchema,
} from "@pstdio/pocketcoder-contracts";
import type { Store, TemplateRow } from "@pstdio/pocketcoder-runtime-core";
import { type AppEnv, requireScope } from "../middleware";
import { decodeStringCursor, encodeCursor } from "../pagination";
import { templateAuthorized } from "../service";
import { COMMON_ERROR_RESPONSES } from "./shared";

function safeTemplateItem(row: TemplateRow) {
	return {
		name: row.name,
		version: row.version,
		digest: row.digest,
		...(row.description ? { description: row.description } : {}),
		status: row.status,
	};
}

export function registerCatalogRoutes({ app, store }: { app: OpenAPIHono<AppEnv>; store: Store }) {
	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/templates",
			operationId: "listTemplates",
			tags: ["Templates"],
			middleware: [requireScope("templates:read")] as const,
			request: { query: TemplateListQuerySchema },
			responses: {
				200: {
					description: "Authorized template versions",
					content: {
						"application/json": {
							schema: TemplatePageSchema,
						},
					},
				},
				...COMMON_ERROR_RESPONSES,
			},
		}),
		async (c) => {
			const principal = c.get("principal");
			const names = principal.templateNames.includes("*") ? null : principal.templateNames;
			const { cursor, limit } = c.req.valid("query");
			const after = decodeStringCursor("templates", cursor);
			const rows = (await store.listTemplates(names)).toSorted((left, right) => {
				const leftKey = `${left.name}\0${left.version}`;
				const rightKey = `${right.name}\0${right.version}`;
				return leftKey.localeCompare(rightKey);
			});
			const remaining = after ? rows.filter((row) => `${row.name}\0${row.version}` > after) : rows;
			const hasMore = remaining.length > limit;
			const items = remaining.slice(0, limit);
			const last = items.at(-1);
			return c.json(
				{
					items: items.map(safeTemplateItem),
					next_cursor:
						hasMore && last ? encodeCursor("templates", `${last.name}\0${last.version}`) : null,
				},
				200,
			);
		},
	);

	app.openapi(
		createRoute({
			method: "get",
			path: "/v1/templates/{name}",
			operationId: "getTemplate",
			tags: ["Templates"],
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
				...COMMON_ERROR_RESPONSES,
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
}
