import type { Hono } from "hono";
import { z } from "zod";
import type { accountService } from "../accounts/service";
import type { ManagerStore } from "../database/store";
import type { Release } from "./releases";

export function registerUpgradeRoutes(
  app: Hono<{ Variables: { operator: NonNullable<Awaited<ReturnType<ManagerStore["operator"]>>> } }>,
  releases: Release[],
  service: ReturnType<typeof accountService>,
) {
  app.post("/v1/accounts/:id/upgrade", async (c) => {
    const input = z.strictObject({ version: z.string().min(1).max(128) }).parse(await c.req.json());
    const result = await service.beginUpgrade(
      z.uuid().parse(c.req.param("id")),
      z.string().min(1).max(128).parse(c.req.header("idempotency-key")),
      input.version,
      releases,
      c.get("operator").expiresAt,
    );
    return c.json(
      { account: { id: result.account.id, state: result.account.state }, operation: result.operation },
      202,
    );
  });
  app.post("/v1/accounts/:id/upgrade-recovery", async (c) => {
    const input = z
      .discriminatedUnion("action", [
        z.strictObject({ operation_id: z.uuid(), action: z.literal("rollback") }),
        z.strictObject({ operation_id: z.uuid(), action: z.literal("restore") }),
        z.strictObject({
          operation_id: z.uuid(),
          action: z.literal("forward_fix"),
          version: z.string().min(1).max(128),
        }),
      ])
      .parse(await c.req.json());
    return c.json(
      {
        operation: await service.recoverUpgrade(
          z.uuid().parse(c.req.param("id")),
          input.operation_id,
          input.action,
          "version" in input ? input.version : undefined,
          releases,
          c.get("operator").expiresAt,
        ),
      },
      202,
    );
  });
}
