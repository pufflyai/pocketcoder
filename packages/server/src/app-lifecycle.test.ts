import { describe, expect, test } from "bun:test";
import { authed, createTestBody, createTestServer } from "./test-server.test";

describe("workspace lifecycle API", () => {
  test("get, list, and idempotent cancel", async () => {
    const { app, token, store } = await createTestServer();
    const res = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "c1" },
        body: createTestBody("cancel-me"),
      }),
    );
    const ws = (await res.json()) as { id: string };

    const got = await app.request(`/v1/workspaces/${ws.id}`, authed(token));
    expect(got.status).toBe(200);

    const list = await app.request("/v1/workspaces?external_id=cancel-me", authed(token));
    const listBody = (await list.json()) as { items: Array<{ id: string }> };
    expect(listBody.items.map((i) => i.id)).toContain(ws.id);

    // The scheduler may already have admitted the workspace, so the first
    // cancel can return the transient `terminating` state; it must settle
    // at `canceled`.
    const cancel1 = await app.request(
      `/v1/workspaces/${ws.id}/cancel`,
      authed(token, { method: "POST" }),
    );
    expect(cancel1.status).toBe(200);
    expect(["terminating", "canceled"]).toContain(
      ((await cancel1.json()) as { state: string }).state,
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await store.getWorkspace(ws.id))?.state !== "canceled") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await store.getWorkspace(ws.id))?.state).toBe("canceled");

    const cancel2 = await app.request(
      `/v1/workspaces/${ws.id}/cancel`,
      authed(token, { method: "POST" }),
    );
    expect(cancel2.status).toBe(200);
    expect(((await cancel2.json()) as { state: string }).state).toBe("canceled");

    const row = await store.getWorkspace(ws.id);
    expect(row?.reasonCode).toBe("canceled_by_caller");
  });

  test("other principals cannot see the workspace", async () => {
    const { app, token, limitedToken } = await createTestServer();
    const res = await app.request(
      "/v1/workspaces",
      authed(token, {
        method: "POST",
        headers: { "idempotency-key": "p1" },
        body: createTestBody(),
      }),
    );
    const ws = (await res.json()) as { id: string };
    const other = await app.request(`/v1/workspaces/${ws.id}`, authed(limitedToken));
    expect(other.status).toBe(403); // read-only principal lacks workspaces:read
  });
});

describe("historical conversations", () => {
  test("filters the principal-scoped session index by exact metadata and time", async () => {
    const server = await createTestServer({ globalActiveWorkspaces: 0 });
    for (const [id, user] of [
      ["session-a", "user-1"],
      ["session-b", "user-2"],
    ] as const) {
      const response = await server.app.request(
        "/v1/workspaces",
        authed(server.token, {
          method: "POST",
          headers: { "idempotency-key": id },
          body: JSON.stringify({
            external_id: id,
            template: { name: "fixture-echo" },
            metadata: { product: "onefin", tenant: "tenant-7", user },
          }),
        }),
      );
      expect(response.status).toBe(201);
    }
    const metadata = encodeURIComponent(
      JSON.stringify({ product: "onefin", tenant: "tenant-7", user: "user-1" }),
    );
    const response = await server.app.request(
      `/v1/workspaces?metadata=${metadata}`,
      authed(server.token),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ external_id: string }> };
    expect(body.items.map((item) => item.external_id)).toEqual(["session-a"]);

    const invalidRange = await server.app.request(
      `/v1/workspaces?created_after=${encodeURIComponent("2026-08-04T00:00:00.000Z")}&created_before=${encodeURIComponent("2026-08-03T00:00:00.000Z")}`,
      authed(server.token),
    );
    expect(invalidRange.status).toBe(400);
  });

  test("reads a terminal transcript with stable pages, deduplicates, and deletes content", async () => {
    const server = await createTestServer({ globalActiveWorkspaces: 0 });
    const createdResponse = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "idempotency-key": "history-1" },
        body: createTestBody("history-1"),
      }),
    );
    const workspace = (await createdResponse.json()) as { id: string };
    const occurredAt = new Date("2026-08-03T08:00:00.000Z");
    const first = await server.store.appendConversationMessage({
      workspaceId: workspace.id,
      messageId: "m-1",
      role: "user",
      content: "Fix the failing test",
      occurredAt,
      metadata: { provider: "agentapi" },
      createdAt: occurredAt,
    });
    const duplicate = await server.store.appendConversationMessage({
      workspaceId: workspace.id,
      messageId: "m-1",
      role: "user",
      content: "must not replace the first payload",
      occurredAt,
      metadata: {},
      createdAt: occurredAt,
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.message.content).toBe("Fix the failing test");
    await server.store.appendConversationMessage({
      workspaceId: workspace.id,
      messageId: "m-2",
      role: "assistant",
      content: "Implemented the fix",
      occurredAt: new Date("2026-08-03T08:01:00.000Z"),
      metadata: {},
      createdAt: occurredAt,
    });
    await server.store.transition(workspace.id, {
      from: ["queued"],
      to: "canceled",
      reason: "canceled_by_caller",
      at: new Date(),
    });

    const page1 = await server.app.request(
      `/v1/workspaces/${workspace.id}/conversation?limit=1`,
      authed(server.token),
    );
    expect(page1.status).toBe(200);
    const firstPage = (await page1.json()) as {
      items: Array<{ message_id: string; content: string }>;
      next_cursor: string;
      retention: { status: string; expires_at: string };
    };
    expect(firstPage.items).toEqual([
      expect.objectContaining({ message_id: "m-1", content: "Fix the failing test" }),
    ]);
    expect(typeof firstPage.next_cursor).toBe("string");
    expect(firstPage.next_cursor).not.toBe("1");
    expect(firstPage.retention.status).toBe("retained");

    const page2 = await server.app.request(
      `/v1/workspaces/${workspace.id}/conversation?cursor=${encodeURIComponent(firstPage.next_cursor)}&limit=1`,
      authed(server.token),
    );
    const secondPage = (await page2.json()) as {
      items: Array<{ message_id: string }>;
      next_cursor: string | null;
    };
    expect(secondPage.items[0]?.message_id).toBe("m-2");
    expect(secondPage.next_cursor).toBeNull();
    await server.store.setConversationExpiry(workspace.id, new Date(Date.now() - 1), new Date());
    const expired = await server.app.request(
      `/v1/workspaces/${workspace.id}/conversation`,
      authed(server.token),
    );
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
      "conversation.expired",
    );
    expect(await server.store.pruneExpiredConversations(new Date())).toBe(1);
    expect(await server.store.readConversation(workspace.id, 0, 10)).toEqual([]);

    const deleted = await server.app.request(
      `/v1/workspaces/${workspace.id}/conversation`,
      authed(server.token, { method: "DELETE" }),
    );
    expect(deleted.status).toBe(204);
    const afterDelete = await server.app.request(
      `/v1/workspaces/${workspace.id}/conversation`,
      authed(server.token),
    );
    expect(afterDelete.status).toBe(410);
    expect(((await afterDelete.json()) as { error: { code: string } }).error.code).toBe(
      "conversation.deleted",
    );
  });
});
