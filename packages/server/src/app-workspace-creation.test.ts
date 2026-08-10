import { describe, expect, test } from "bun:test";
import { authed, createTestBody, createTestServer } from "./test-server.test";

describe("workspace creation", () => {
  test("creates queued workspace and is idempotent on the same key and body", async () => {
    const { app, store, token } = await createTestServer();
    const body = createTestBody("task-1");
    const first = await app.request(
      "/v1/workspaces",
      authed(token, { method: "POST", headers: { "idempotency-key": "idem-1" }, body }),
    );
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      id: string;
      state: string;
      template: { digest: string };
    };
    expect(created.state).toBe("queued");
    expect(created.template.digest.startsWith("sha256:")).toBe(true);
    expect((created as { change_cursor?: number }).change_cursor).toBe(1);
    expect((created as { agent_state?: string }).agent_state).toBe("unknown");
    expect((created as { failure?: unknown }).failure).toBeNull();
    expect((await store.getWorkspace(created.id))?.templateSnapshot.services).toBeDefined();

    const repeat = await app.request(
      "/v1/workspaces",
      authed(token, { method: "POST", headers: { "idempotency-key": "idem-1" }, body }),
    );
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { id: string }).id).toBe(created.id);
  });

  test("replays an existing workspace even after the queue becomes full", async () => {
    const { app, token } = await createTestServer({
      maxQueuedWorkspaces: 1,
      globalActiveWorkspaces: 0,
    });
    const body = createTestBody("retry-after-capacity");
    const first = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "retry-after-capacity" },
        body,
      }),
    );
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string };

    const replay = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "retry-after-capacity" },
        body,
      }),
    );

    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { id: string }).id).toBe(created.id);
  });

  test("reserves queue capacity atomically across concurrent creates", async () => {
    const { app, token, store } = await createTestServer({
      maxQueuedWorkspaces: 1,
      globalActiveWorkspaces: 0,
    });
    const requests = ["concurrent-capacity-a", "concurrent-capacity-b"].map((id) =>
      app.request(
        "/v1/workspaces",
        authed(token, {
          method: "POST",
          headers: { "idempotency-key": id },
          body: createTestBody(id),
        }),
      ),
    );

    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    expect(await store.countQueued()).toBe(1);
  });

  test("does not advertise a next page at an exact collection boundary", async () => {
    const { app, token } = await createTestServer({ globalActiveWorkspaces: 0 });
    for (const id of ["page-boundary-a", "page-boundary-b"]) {
      expect(
        (
          await app.request(
            "/v1/workspaces",
            authed(token, {
              method: "POST",
              headers: { "idempotency-key": id },
              body: createTestBody(id),
            }),
          )
        ).status,
      ).toBe(201);
    }

    const response = await app.request("/v1/workspaces?limit=2", authed(token));
    const page = (await response.json()) as { items: unknown[]; next_cursor: string | null };
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  test("conflicting body under the same idempotency key returns 409", async () => {
    const { app, token } = await createTestServer();
    await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "idem-2" },
        body: createTestBody("task-a"),
      }),
    );
    const res = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "idem-2" },
        body: createTestBody("task-b"),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "idempotency.conflict",
    );
  });

  test("missing Idempotency-Key is a validation error", async () => {
    const { app, token } = await createTestServer();
    const res = await app.request(
      "/v1/workspaces",
      authed(token, { method: "POST", body: createTestBody() }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "Idempotency-Key header is required.",
    );
  });
});

describe("workspace creation diagnostics", () => {
  test("long-polls a durable workspace change cursor", async () => {
    const { app, store, token } = await createTestServer({ globalActiveWorkspaces: 0 });
    const createdRes = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "changes-1" },
        body: createTestBody("changes-1"),
      }),
    );
    const created = (await createdRes.json()) as { id: string; change_cursor: number };
    const noChange = await app.request(
      `/v1/workspaces/${created.id}/changes?after=${created.change_cursor}&wait=0`,
      authed(token),
    );
    expect(noChange.status).toBe(200);
    expect((await noChange.json()) as unknown).toMatchObject({
      cursor: created.change_cursor,
      changed: false,
    });

    const waitUrl = `/v1/workspaces/${created.id}/changes?after=${created.change_cursor}&wait=1`;
    const waiting = [
      app.request(waitUrl, authed(token)),
      app.request(waitUrl, authed(token)),
    ] as const;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.transition(created.id, {
      from: ["queued"],
      to: "canceled",
      reason: "canceled_by_caller",
      at: new Date(),
    });
    const [changed, secondChanged] = await Promise.all(waiting);
    expect(changed.status).toBe(200);
    expect(secondChanged.status).toBe(200);
    const body = (await changed.json()) as {
      cursor: number;
      changed: boolean;
      workspace: { state: string; change_cursor: number };
    };
    expect(body.changed).toBe(true);
    expect(body.cursor).toBeGreaterThan(created.change_cursor);
    expect(body.workspace.state).toBe("canceled");
    expect(body.workspace.change_cursor).toBe(body.cursor);
    expect((await secondChanged.json()) as unknown).toMatchObject({
      cursor: body.cursor,
      changed: true,
      workspace: { state: "canceled" },
    });
  });

  test("returns a bounded log tail with a failed workspace", async () => {
    const server = await createTestServer();
    const createdRes = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": "failure-tail-1" },
        body: createTestBody("failure-tail-1"),
      }),
    );
    const created = (await createdRes.json()) as { id: string };
    await server.scheduler.tick();
    const row = await server.store.getWorkspace(created.id);
    expect(row).not.toBeNull();
    await server.store.appendLogs(created.id, [
      {
        stream: "stderr",
        occurredAt: new Date(),
        content: new TextEncoder().encode(`${"x".repeat(17_000)}\n`),
      },
      {
        stream: "stderr",
        occurredAt: new Date(),
        content: new TextEncoder().encode(
          "Authorization: Bearer should-not-leak\nTraceback (most recent call last):\nPermissionError: /home/onefin/.pi\n",
        ),
      },
    ]);
    await server.scheduler.fail(row as NonNullable<typeof row>, "child_exit_failure", new Date());

    const response = await server.app.request(`/v1/workspaces/${created.id}`, authed(server.token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      failure: {
        reason_code: string;
        log_tail: string;
        log_tail_truncated: boolean;
        last_log_seq: number;
      };
    };
    expect(body.failure.reason_code).toBe("child_exit_failure");
    expect(body.failure.log_tail).toContain("PermissionError: /home/onefin/.pi");
    expect(body.failure.log_tail).not.toContain("should-not-leak");
    expect(body.failure.log_tail).toContain("[redacted]");
    expect(body.failure.log_tail_truncated).toBe(true);
    expect(body.failure.last_log_seq).toBe(2);
  });

  test("unauthorized template returns 403, unknown 404, full queue 429", async () => {
    // globalActiveWorkspaces: 0 keeps admission from draining the queue
    // so the queue-full path is deterministic.
    const { app, token } = await createTestServer({
      maxQueuedWorkspaces: 1,
      globalActiveWorkspaces: 0,
    });
    const sleepBody = JSON.stringify({ external_id: "t", template: { name: "fixture-sleep" } });
    const forbidden = await app.request(
      "/v1/workspaces",
      authed(token, { method: "POST", headers: { "idempotency-key": "k1" }, body: sleepBody }),
    );
    expect(forbidden.status).toBe(403);

    const unknown = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "k2" },
        body: JSON.stringify({ external_id: "t2", template: { name: "fixture-echo" } }),
      }),
    );
    expect(unknown.status).toBe(201);

    const overflow = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "k3" },
        body: createTestBody(),
      }),
    );
    expect(overflow.status).toBe(429);
  });

  test("oversized launch_input is rejected by the template limit", async () => {
    const { app, token } = await createTestServer();
    const res = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "big" },
        body: JSON.stringify({
          external_id: "big",
          template: { name: "fixture-echo" },
          launch_input: { blob: "x".repeat(70_000) },
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
