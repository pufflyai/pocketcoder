import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { issueEgressAuditToken } from "@pstdio/pocketcoder-auth";
import { Readiness } from "./health";
import {
  authed,
  createTestBody,
  createTestServer,
  SERVER_TEST_PEPPER as PEPPER,
} from "./test-server.test";

describe("authentication", () => {
  test("rejects missing and invalid keys with the stable envelope", async () => {
    const { app } = await createTestServer();
    const res = await app.request("/v1/templates");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; request_id: string } };
    expect(body.error.code).toBe("auth.invalid_key");
    expect(body.error.request_id.length).toBeGreaterThan(0);

    const res2 = await app.request("/v1/templates", authed("pkt_bad_token"));
    expect(res2.status).toBe(401);
  });

  test("propagates a bounded caller request ID on success and errors", async () => {
    const { app, token } = await createTestServer();
    const requestId = "caller-trace-123";
    const success = await app.request(
      "/v1/templates",
      authed(token, { headers: { "x-request-id": requestId } }),
    );
    expect(success.headers.get("x-request-id")).toBe(requestId);

    const failure = await app.request("/v1/templates", {
      headers: { "x-request-id": requestId },
    });
    expect(failure.headers.get("x-request-id")).toBe(requestId);
    expect(((await failure.json()) as { error: { request_id: string } }).error.request_id).toBe(
      requestId,
    );
  });

  test("rejects revoked keys on the next request", async () => {
    const { app, store, token } = await createTestServer();
    const keyId = token.split("_")[1] as string;
    expect((await app.request("/v1/templates", authed(token))).status).toBe(200);
    await store.revokeMachineKey(keyId, new Date());
    expect((await app.request("/v1/templates", authed(token))).status).toBe(401);
  });

  test("enforces scopes", async () => {
    const { app, limitedToken } = await createTestServer();
    const res = await app.request(
      "/v1/workspaces",
      authed(limitedToken, {
        method: "POST",
        headers: { "idempotency-key": "k1" },
        body: createTestBody(),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth.missing_scope");
  });

  test("default-issued keys inherit current principal scopes", async () => {
    const { app, store, token } = await createTestServer();
    expect((await app.request("/v1/templates", authed(token))).status).toBe(200);
    const principal = await store.getPrincipalByName("test-backend");
    if (!principal) throw new Error("expected test principal");
    await store.updatePrincipal(
      principal.id,
      principal.scopes.filter((scope) => scope !== "templates:read"),
      principal.templateNames,
    );
    expect((await app.request("/v1/templates", authed(token))).status).toBe(403);
  });
});

describe("health", () => {
  test("separates process liveness from dependency readiness", async () => {
    const { app } = await createTestServer();
    const live = await app.request("/livez");
    const ready = await app.request("/readyz");

    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ ok: true });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ok: true,
      checks: {
        database: "ok",
        schema: "ok",
        reconciliation: "ok",
        coordinator: "ok",
      },
    });
  });

  test("keeps liveness healthy while a failed dependency makes readiness unavailable", async () => {
    const readiness = new Readiness();
    readiness.set("reconciliation", "failed");
    const { app } = await createTestServer({}, readiness);

    expect((await app.request("/livez")).status).toBe(200);
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      ok: false,
      checks: { reconciliation: "failed" },
    });
  });
});

describe("templates", () => {
  test("lists only authorized templates", async () => {
    const { app, token } = await createTestServer();
    const res = await app.request("/v1/templates", authed(token));
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["fixture-echo", "fixture-terminal"]);
  });

  test("unauthorized template names look nonexistent", async () => {
    const { app, token } = await createTestServer();
    const res = await app.request("/v1/templates/fixture-sleep", authed(token));
    expect(res.status).toBe(404);
  });
});

describe("workspace network audits", () => {
  test("authenticates, deduplicates, redacts, paginates, and authorizes events", async () => {
    const server = await createTestServer();
    const createdResponse = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": "network-audit" },
        body: createTestBody("network-audit"),
      }),
    );
    const workspace = (await createdResponse.json()) as { id: string };
    const auditToken = issueEgressAuditToken(PEPPER, {
      kind: "workspace",
      id: workspace.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const sourceSession = randomUUID();
    const event = {
      source_seq: 1,
      occurred_at: new Date().toISOString(),
      decision: "allow",
      transport: "http",
      host: "github.com",
      port: 443,
      method: "GET",
      path: "/repos/pstdio/pocketcoder",
      matched_rule: "github.com",
      reason: "matched_rule",
    };
    const body = JSON.stringify({ source_session_id: sourceSession, events: [event] });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await server.app.request("/v1/internal/egress/events", {
        method: "POST",
        headers: { authorization: `Bearer ${auditToken}`, "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(202);
    }
    const page = await server.app.request(
      `/v1/workspaces/${workspace.id}/network-events?limit=1`,
      authed(server.token),
    );
    expect(page.status).toBe(200);
    const events = (await page.json()) as {
      items: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({ seq: 1, host: "github.com", path: event.path });
    expect(JSON.stringify(events)).not.toContain("authorization");
    expect(events.next_cursor).toBeNull();
    const forbidden = await server.app.request(
      `/v1/workspaces/${workspace.id}/network-events`,
      authed(server.limitedToken),
    );
    expect(forbidden.status).toBe(403);
  });

  test("rejects expired audit credentials", async () => {
    const server = await createTestServer();
    const token = issueEgressAuditToken(PEPPER, {
      kind: "workspace",
      id: randomUUID(),
      expiresAt: new Date(Date.now() - 1),
    });
    const response = await server.app.request("/v1/internal/egress/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});
