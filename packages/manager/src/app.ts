import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ManagerError } from "./accounts/errors";
import { accountService } from "./accounts/service";
import {
  AccountInputSchema,
  accountPlan,
  BootstrapInputSchema,
  type ManagerConfig,
  ManagerConfigSchema,
} from "./config";
import type { Account, ManagerStore } from "./database/store";
import { accountOrigins } from "./kubernetes/public-hosts";
import { managerMonitoring } from "./monitoring/metrics";
import { registerUpgradeRoutes } from "./upgrade/routes";

export { accountService } from "./accounts/service";
export type { ManagerConfig } from "./config";
export { usageSampler } from "./usage/sampler";
export function accountResource(account: Account) {
  const origins = account.plan.publicHosts && accountOrigins(account.id, account.plan.publicHosts);
  return {
    id: account.id,
    name: account.name,
    state: account.state,
    namespace: account.namespace,
    created_at: account.createdAt.toISOString(),
    bootstrap: account.bootstrapRequestId ? "requested" : "unclaimed",
    api_origin: origins?.api ?? null,
    view_origin: origins?.views ?? null,
  };
}
export function createManagerApp(
  store: ManagerStore,
  input: ManagerConfig,
  service = accountService(store),
  monitoring = managerMonitoring(store),
) {
  const config = ManagerConfigSchema.parse(input);
  const app = new Hono<{ Variables: { operator: NonNullable<Awaited<ReturnType<ManagerStore["operator"]>>> } }>();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
    const operator = match?.[1] ? await store.operator(match[1]) : null;
    if (!operator) return c.json({ code: "unauthorized" }, 401);
    if (operator.purpose === "metrics" && (c.req.path !== "/metrics" || c.req.method !== "GET"))
      return c.json({ code: "forbidden" }, 403);
    c.set("operator", operator);
    await next();
    if (operator.expiresAt <= new Date()) c.res = c.json({ code: "unauthorized" }, 401);
  });
  app.use("*", bodyLimit({ maxSize: 8192, onError: (c) => c.json({ code: "request_too_large" }, 413) }));
  app.onError((error, c) => {
    if (error instanceof ManagerError) return c.json({ code: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: "invalid_request" }, 400);
    return c.json({ code: "manager_error" }, 500);
  });
  app.post("/v1/accounts", async (c) => {
    const requestId = z.string().min(1).max(128).parse(c.req.header("idempotency-key"));
    const input = AccountInputSchema.parse(await c.req.json());
    const plan = () => accountPlan(config, input);
    const result = await store.createAccount(requestId, input, plan, c.get("operator").expiresAt);
    return c.json({ account: accountResource(result.account), operation: result.operation }, 202);
  });
  app.get("/metrics", async (c) => {
    c.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
    const expiry = c.get("operator").expiresAt.getTime() / 1000;
    return c.body(
      `${await monitoring.metrics()}# TYPE pocketcoder_metrics_credential_expires_at_seconds gauge\npocketcoder_metrics_credential_expires_at_seconds ${expiry}\n`,
    );
  });
  registerUpgradeRoutes(app, config.releases ?? [], service);
  app.get("/v1/releases", (c) => c.json({ items: config.releases ?? [] }));
  app.get("/v1/accounts", async (c) => c.json({ items: (await store.listAccounts()).map(accountResource) }));
  app.post("/v1/accounts/:id/purge", async (c) =>
    c.json(
      {
        operation: await service.purge(
          z.uuid().parse(c.req.param("id")),
          z.string().min(1).max(128).parse(c.req.header("idempotency-key")),
          c.get("operator").expiresAt,
        ),
      },
      202,
    ),
  );
  app.post("/v1/accounts/:id/backups", async (c) => {
    const result = await store.beginBackupOperation(
      z.uuid().parse(c.req.param("id")),
      "backup",
      z.string().min(1).max(128).parse(c.req.header("idempotency-key")),
      c.get("operator").expiresAt,
    );
    return c.json({ account: accountResource(result.account), operation: result.operation }, 202);
  });
  app.get("/v1/accounts/:id/backups", async (c) =>
    c.json({ items: await store.listBackups(z.uuid().parse(c.req.param("id"))) }),
  );
  app.post("/v1/accounts/:id/restore", async (c) => {
    const input = z.strictObject({ backup_id: z.uuid() }).parse(await c.req.json());
    const result = await store.beginBackupOperation(
      z.uuid().parse(c.req.param("id")),
      "restore",
      z.string().min(1).max(128).parse(c.req.header("idempotency-key")),
      c.get("operator").expiresAt,
      input.backup_id,
    );
    return c.json({ account: accountResource(result.account), operation: result.operation }, 202);
  });
  for (const kind of ["suspend", "resume"] as const) {
    app.post(`/v1/accounts/:id/${kind}`, async (c) => {
      const result = await store.beginLifecycle(
        z.uuid().parse(c.req.param("id")),
        kind,
        z.string().min(1).max(128).parse(c.req.header("idempotency-key")),
        c.get("operator").expiresAt,
      );
      return c.json({ account: accountResource(result.account), operation: result.operation }, 202);
    });
  }
  app.get("/v1/accounts/:id", async (c) => {
    const account = await store.getAccount(z.uuid().parse(c.req.param("id")));
    if (!account) throw new ManagerError(404, "account_not_found");
    return c.json(accountResource(account));
  });
  app.get("/v1/operations/:id", async (c) => {
    const id = z.uuid().parse(c.req.param("id"));
    const purge = await store.purgeRuntime?.status(id);
    if (purge) return c.json(purge);
    const operation = await store.getOperation(id);
    if (!operation) throw new ManagerError(404, "operation_not_found");
    return c.json(operation);
  });
  app.get("/v1/accounts/:id/usage", async (c) => c.json(await store.getUsage(z.uuid().parse(c.req.param("id")))));
  app.post("/v1/accounts/:id/owner", async (c) =>
    c.json(
      await service.bootstrap(
        z.uuid().parse(c.req.param("id")),
        BootstrapInputSchema.parse(await c.req.json()),
        c.get("operator").expiresAt,
      ),
    ),
  );
  return app;
}
