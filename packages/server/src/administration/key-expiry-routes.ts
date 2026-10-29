import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ExpiringKeyListResponseSchema } from "@pstdio/pocketcoder-contracts";
import { keyResource, type Store } from "@pstdio/pocketcoder-runtime-core";
import type { Context } from "hono";
import { type AppEnv, requireScope } from "../http/middleware";
import { COMMON_ERROR_RESPONSES } from "../http/shared-routes";
import { keyInventoryVisible } from "./principal-authority";

const HOUR = 3_600_000;
const EARLIEST_EXPIRY = "pocketcoder_principal_key_earliest_expiry_seconds";

async function visibleActiveKeys(c: Context<AppEnv>, store: Store, before?: Date) {
  const rows = await store.listActiveMachineKeys(new Date(), before);
  return rows.filter((row) => keyInventoryVisible(c, row.principal));
}

// Rows arrive soonest first, so the first row per principal is its earliest expiry.
function earliestExpiryMetrics(rows: Awaited<ReturnType<Store["listActiveMachineKeys"]>>) {
  const lines = [
    `# HELP ${EARLIEST_EXPIRY} Unix time when the principal's first active machine key expires.`,
    `# TYPE ${EARLIEST_EXPIRY} gauge`,
  ];
  const seen = new Set<string>();
  for (const { key, principal } of rows) {
    if (seen.has(principal.id) || !key.expiresAt) continue;
    seen.add(principal.id);
    const labels = `principal_id=${JSON.stringify(principal.id)},principal_name=${JSON.stringify(principal.name)}`;
    lines.push(`${EARLIEST_EXPIRY}{${labels}} ${key.expiresAt.getTime() / 1000}`);
  }
  return `${lines.join("\n")}\n`;
}

export function registerKeyExpiryRoutes(app: OpenAPIHono<AppEnv>, store: Store) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/keys/expiring",
      operationId: "listExpiringKeys",
      tags: ["Keys"],
      middleware: [requireScope("keys:read")] as const,
      request: {
        query: z.object({ within_hours: z.coerce.number().int().min(1).max(8784).default(168) }),
      },
      responses: {
        200: {
          description: "Active keys that expire within the window, soonest first",
          content: { "application/json": { schema: ExpiringKeyListResponseSchema } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => {
      const before = new Date(Date.now() + c.req.valid("query").within_hours * HOUR);
      const rows = await visibleActiveKeys(c, store, before);
      const items = rows.map(({ key, principal }) => ({
        ...keyResource(key, principal),
        principal_name: principal.name,
      }));
      return c.json({ items }, 200);
    },
  );
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/keys/metrics",
      operationId: "getKeyMetrics",
      tags: ["Keys"],
      middleware: [requireScope("keys:read")] as const,
      responses: {
        200: {
          description: "Prometheus text with the earliest active key expiry per principal",
          content: { "text/plain": { schema: z.string() } },
        },
        ...COMMON_ERROR_RESPONSES,
      },
    }),
    async (c) => c.text(earliestExpiryMetrics(await visibleActiveKeys(c, store)), 200),
  );
}
