import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { ApiError } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { type AppEnv, errorHandler, machineAuth, requestId, requestLogging } from "../http/middleware";
import { createStructuredLogger } from "../observability/observability";
import { registerSecretRoutes } from "./secret-routes";
import { createSecretVault } from "./secret-vault";

const createStore = createTestStoreFactory();
const input = {
  type: "registry",
  value: { server: "registry.example", username: "operator", password: "do-not-print-me" },
} as const;

async function fixture(scopes = ["secrets:write"]) {
  const store = await createStore();
  const principal = await store.createPrincipal("operator", scopes, []);
  const key = issueMachineKey("secret-http");
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const logs: unknown[] = [];
  const app = new OpenAPIHono<AppEnv>({
    defaultHook(result) {
      if (!result.success) throw new ApiError("validation.invalid", result.error.message);
    },
  });
  const logger = createStructuredLogger((line) => logs.push(line));
  app.onError(errorHandler(logger));
  app.use("*", requestId);
  app.use("*", requestLogging(logger));
  app.use("/v1/*", machineAuth(store, "secret-http"));
  const vault = createSecretVault(store, randomBytes(32));
  registerSecretRoutes(app, vault);
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    });
  return { store, principal, key, vault, app, request, logs };
}

test("secret HTTP API and SDK return metadata only and retire names", async () => {
  const f = await fixture();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
  try {
    const client = new PocketCoderClient({ baseUrl: server.url.toString(), apiKey: f.key.token });
    const saved = await client.secrets.put("pull", input);
    expect(saved).toMatchObject({ name: "pull", type: "registry", retired_at: null });
    expect(await client.secrets.list()).toEqual([saved]);
    expect((await client.secrets.retire("pull")).retired_at).not.toBeNull();
    await expect(f.vault.resolve("pull", "registry")).rejects.toMatchObject({ code: "secret.unavailable" });
    expect(JSON.stringify(f.logs)).not.toContain(input.value.password);
  } finally {
    await server.stop(true);
  }
});

test("setup issuer publication returns only metadata through HTTP", async () => {
  const f = await fixture();
  const value = {
    url: "https://issuer.example/setup",
    authorization: "Bearer standing-controller-only",
    policy: { repositories: ["https://source.example/private.git"] },
  };
  const response = await f.request("/v1/secrets/private-source", {
    method: "PUT",
    body: JSON.stringify({ type: "setup-issuer", value }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: "private-source", type: "setup-issuer" });
  expect(JSON.stringify(f.logs)).not.toContain(value.authorization);
});

test("secret routes reject missing scope before reading values", async () => {
  const f = await fixture(["templates:write"]);
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  expect((await f.request("/v1/secrets/pull", { method: "PUT", body })).status).toBe(403);
  expect(reads).toBe(0);
  expect((await f.request("/v1/secrets")).status).toBe(403);
  expect((await f.request("/v1/secrets/pull", { method: "DELETE" })).status).toBe(403);
  expect(await f.store.readSecret("pull")).toBeNull();
});

test("invalid secret bodies and names never echo sensitive input in responses or logs", async () => {
  const f = await fixture();
  for (const [name, body] of [
    ["pull", "{do-not-print-me"],
    ["pull", JSON.stringify({ ...input, type: input.value.password })],
    ["pull", JSON.stringify({ ...input, value: { ...input.value, [input.value.password]: "extra" } })],
    [`${input.value.password}:`, JSON.stringify(input)],
    [
      "pull",
      JSON.stringify({
        type: "runtime-issuer",
        value: { url: "http://do-not-print-me", authorization: input.value.password, policy: {} },
      }),
    ],
    [
      "pull",
      JSON.stringify({
        type: "runtime-issuer",
        value: { url: input.value.password, authorization: input.value.password, policy: {} },
      }),
    ],
  ] as const) {
    const response = await f.request(`/v1/secrets/${encodeURIComponent(name)}`, { method: "PUT", body });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(input.value.password);
  }
  const large = await f.request("/v1/secrets/pull", { method: "PUT", body: " ".repeat(65_537) });
  expect(large.status).toBe(413);
  expect(JSON.stringify(f.logs)).not.toContain(input.value.password);
  expect(await f.store.readSecret("pull")).toBeNull();
});

test.each(["revoke", "disable", "scope"])("PUT rechecks %s after the body is read", async (change) => {
  const f = await fixture();
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.resolve();
        await release.promise;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = f.request("/v1/secrets/pull", { method: "PUT", body });
  await reading.promise;
  try {
    if (change === "revoke") await f.store.revokeMachineKey(f.key.id, new Date());
    else if (change === "disable") await f.store.setPrincipalDisabled(f.principal.id, true);
    else await f.store.updatePrincipal(f.principal.id, [], []);
  } finally {
    release.resolve();
  }
  expect((await request).status).toBe(change === "revoke" ? 401 : 403);
  expect(await f.store.readSecret("pull")).toBeNull();
});

test("rejected secret paths cannot leak values through workspace or operation log IDs", async () => {
  const f = await fixture();
  for (const resource of ["workspaces", "operations"]) {
    const response = await f.request(`/v1/secrets/${resource}/${input.value.password}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(404);
  }
  expect(JSON.stringify(f.logs)).not.toContain(input.value.password);
});
