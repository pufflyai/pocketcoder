import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ManagerError } from "./accounts/errors";
import { accountService } from "./accounts/service";
import { AccountInputSchema, BootstrapInputSchema, type ManagerConfig, ManagerConfigSchema } from "./config";
import type { Account, ManagerStore } from "./database/store";

export { accountService } from "./accounts/service";
export { usageSampler } from "./usage/sampler";
export function accountResource(account: Account) {
  return {
    id: account.id,
    name: account.name,
    state: account.state,
    namespace: account.namespace,
    created_at: account.createdAt.toISOString(),
    bootstrap: account.bootstrapRequestId ? "requested" : "unclaimed",
  };
}
export function createManagerApp(store: ManagerStore, input: ManagerConfig, service = accountService(store)) {
  const config = ManagerConfigSchema.parse(input);
  const app = new Hono<{ Variables: { operator: NonNullable<Awaited<ReturnType<ManagerStore["operator"]>>> } }>();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header("authorization") ?? "");
    const operator = match?.[1] ? await store.operator(match[1]) : null;
    if (!operator) return c.json({ code: "unauthorized" }, 401);
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
    const result = await store.createAccount(
      requestId,
      AccountInputSchema.parse(await c.req.json()),
      config,
      c.get("operator").expiresAt,
    );
    return c.json({ account: accountResource(result.account), operation: result.operation }, 202);
  });
  app.get("/v1/accounts", async (c) => c.json({ items: (await store.listAccounts()).map(accountResource) }));
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
    const operation = await store.getOperation(z.uuid().parse(c.req.param("id")));
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
