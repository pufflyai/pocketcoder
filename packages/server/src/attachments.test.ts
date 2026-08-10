import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  ATTACHMENT_CHUNK_BYTES,
  ATTACHMENT_MAX_FILE_BYTES,
  type AttachmentDescriptor,
} from "@pstdio/pocketcoder-contracts";
import {
  authed,
  createTestServer,
  fakeAgent,
  readyWorkspace,
  type TestServer,
  uploadRequest,
} from "./attachments-support.test";

describe("attachment upload", () => {
  test("streams chunked frames through the supervisor and returns the descriptor", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const agent = fakeAgent(server, id);
    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1024).fill(7);
    const attachmentId = randomUUID();

    const res = await server.app.request(
      `/v1/workspaces/${id}/attachments/${attachmentId}`,
      uploadRequest(server.token, bytes),
    );
    expect(res.status).toBe(201);
    const descriptor = (await res.json()) as AttachmentDescriptor;
    expect(descriptor).toMatchObject({
      id: attachmentId,
      name: "notes.txt",
      media_type: "text/plain",
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(descriptor.path).toContain(attachmentId);

    const types = agent.frames.map((frame) => frame.type);
    expect(types).toEqual([
      "attachment_start",
      "attachment_chunk",
      "attachment_chunk",
      "attachment_finish",
    ]);
  });

  test("byte-identical retries return 200 and different bytes conflict with 409", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id);
    const attachmentId = randomUUID();
    const bytes = new TextEncoder().encode("stable bytes");

    const first = await server.app.request(
      `/v1/workspaces/${id}/attachments/${attachmentId}`,
      uploadRequest(server.token, bytes),
    );
    expect(first.status).toBe(201);
    const retry = await server.app.request(
      `/v1/workspaces/${id}/attachments/${attachmentId}`,
      uploadRequest(server.token, bytes),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());

    const conflicting = await server.app.request(
      `/v1/workspaces/${id}/attachments/${attachmentId}`,
      uploadRequest(server.token, new TextEncoder().encode("other bytes")),
    );
    expect(conflicting.status).toBe(409);
    expect(((await conflicting.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.conflict",
    );
  });

  test("requires the attachments:write scope", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id);
    const res = await server.app.request(
      `/v1/workspaces/${id}/attachments/${randomUUID()}`,
      uploadRequest(server.relayOnlyToken, new Uint8Array(1)),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "auth.missing_scope",
    );
  });

  test("rejects invalid ids, missing filenames, and oversized declarations", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id);

    const badId = await server.app.request(
      `/v1/workspaces/${id}/attachments/not-a-uuid`,
      uploadRequest(server.token, new Uint8Array(1)),
    );
    expect(badId.status).toBe(400);
    expect(((await badId.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.invalid",
    );

    const noName = await server.app.request(
      `/v1/workspaces/${id}/attachments/${randomUUID()}`,
      authed(server.token, {
        method: "PUT",
        headers: { "content-type": "text/plain", "content-length": "1" },
        body: new Uint8Array(1),
      }),
    );
    expect(noName.status).toBe(400);

    const huge = await server.app.request(
      `/v1/workspaces/${id}/attachments/${randomUUID()}`,
      uploadRequest(server.token, new Uint8Array(ATTACHMENT_MAX_FILE_BYTES + 1)),
    );
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.too_large",
    );
  });

  test("rejects uploads while the workspace is not ready, ended, or disconnected", async () => {
    const server = await createTestServer();
    const res = await server.app.request(
      "/v1/workspaces",
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "gates" },
        body: JSON.stringify({ external_id: "gates", template: { name: "fixture-echo" } }),
      }),
    );
    const ws = (await res.json()) as { id: string };
    const notReady = await server.app.request(
      `/v1/workspaces/${ws.id}/attachments/${randomUUID()}`,
      uploadRequest(server.token, new Uint8Array(1)),
    );
    expect(notReady.status).toBe(409);

    const readyId = await readyWorkspace(server);
    const disconnected = await server.app.request(
      `/v1/workspaces/${readyId}/attachments/${randomUUID()}`,
      uploadRequest(server.token, new Uint8Array(1)),
    );
    expect(disconnected.status).toBe(503);

    await server.app.request(
      `/v1/workspaces/${ws.id}/cancel`,
      authed(server.token, { method: "POST" }),
    );
    const terminal = await server.app.request(
      `/v1/workspaces/${ws.id}/attachments/${randomUUID()}`,
      uploadRequest(server.token, new Uint8Array(1)),
    );
    expect(terminal.status).toBe(410);
  });

  test("rejects uploads to supervisors that predate protocol v3", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id, 2);
    const res = await server.app.request(
      `/v1/workspaces/${id}/attachments/${randomUUID()}`,
      uploadRequest(server.token, new Uint8Array(1)),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.unsupported",
    );
  });
});

describe("agent message attachments", () => {
  async function uploaded(server: TestServer, id: string): Promise<string> {
    const attachmentId = randomUUID();
    const res = await server.app.request(
      `/v1/workspaces/${id}/attachments/${attachmentId}`,
      uploadRequest(server.token, new TextEncoder().encode("attachment body")),
    );
    expect(res.status).toBe(201);
    return attachmentId;
  }

  for (const alias of ["agent", "services/agent"]) {
    test(`appends the manifest and strips ids through /${alias}/message`, async () => {
      const server = await createTestServer();
      const id = await readyWorkspace(server);
      const agent = fakeAgent(server, id);
      const attachmentId = await uploaded(server, id);

      const res = await server.app.request(
        `/v1/workspaces/${id}/${alias}/message`,
        authed(server.token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "user",
            content: "Summarize the attachment.",
            attachment_ids: [attachmentId],
          }),
        }),
      );
      expect(res.status).toBe(200);
      const message = agent.proxied.find((request) => request.path === "/message");
      expect(message).toBeDefined();
      const body = message?.body as { content: string; attachment_ids?: unknown };
      expect(body.attachment_ids).toBeUndefined();
      expect(body.content).toStartWith("Summarize the attachment.");
      expect(body.content).toContain("<pocketcoder-attachments>");
      expect(body.content).toContain(
        `/home/pocketcoder/.pcd/attachments/${attachmentId}/notes.txt`,
      );
    });
  }

  test("keeps text-only messages byte-identical", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const agent = fakeAgent(server, id);
    const res = await server.app.request(
      `/v1/workspaces/${id}/agent/message`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content: "plain text" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(agent.proxied[0]?.body).toEqual({ type: "user", content: "plain text" });
  });

  test("rejects unknown attachment ids without sending anything to the agent", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const agent = fakeAgent(server, id);
    const res = await server.app.request(
      `/v1/workspaces/${id}/agent/message`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content: "x", attachment_ids: [randomUUID()] }),
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.not_found",
    );
    expect(agent.proxied).toEqual([]);
  });

  test("rejects messages whose resolved attachments exceed the aggregate limit", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const agent = fakeAgent(server, id);
    const ids = Array.from({ length: 5 }, () => randomUUID());
    for (const attachmentId of ids) {
      agent.stored.set(attachmentId, {
        id: attachmentId,
        name: "big.bin",
        path: `/home/pocketcoder/.pcd/attachments/${attachmentId}/big.bin`,
        media_type: "application/octet-stream",
        size_bytes: ATTACHMENT_MAX_FILE_BYTES,
        sha256: "a".repeat(64),
      });
    }
    const res = await server.app.request(
      `/v1/workspaces/${id}/agent/message`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content: "x", attachment_ids: ids }),
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.too_large",
    );
    expect(agent.proxied).toEqual([]);
  });

  test("rejects duplicate ids as invalid", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    fakeAgent(server, id);
    const attachmentId = randomUUID();
    const res = await server.app.request(
      `/v1/workspaces/${id}/agent/message`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "user",
          content: "x",
          attachment_ids: [attachmentId, attachmentId],
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.invalid",
    );
  });

  test("rejects attachment messages for supervisors that predate protocol v3", async () => {
    const server = await createTestServer();
    const id = await readyWorkspace(server);
    const agent = fakeAgent(server, id, 2);
    const res = await server.app.request(
      `/v1/workspaces/${id}/agent/message`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content: "x", attachment_ids: [randomUUID()] }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "attachment.unsupported",
    );

    // Text-only relay keeps working for the same connection.
    const plain = await server.app.request(
      `/v1/workspaces/${id}/agent/message`,
      authed(server.token, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "user", content: "still works" }),
      }),
    );
    expect(plain.status).toBe(200);
    expect(agent.proxied[0]?.body).toEqual({ type: "user", content: "still works" });
  });
});
