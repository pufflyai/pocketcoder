import { createHash, randomUUID } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import type { AttachmentDescriptor, ProtocolVersion } from "@pstdio/pocketcoder-contracts";
import { MemoryStore } from "@pstdio/pocketcoder-memory-store";
import { DEFAULT_LIMITS, type Store } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver, fixtureTemplateEcho } from "@pstdio/pocketcoder-testkit";
import type { WSContext } from "hono/ws";
import { type BuiltServer, buildServer } from "./app";

const PEPPER = "attachment-pepper";

export interface TestServer extends BuiltServer {
  store: Store;
  token: string;
  relayOnlyToken: string;
}

export async function createTestServer(): Promise<TestServer> {
  const store = new MemoryStore();
  const driver = new FakeDriver();
  const principal = await store.createPrincipal(
    "attachment-backend",
    [
      "workspaces:create",
      "workspaces:read",
      "workspaces:cancel",
      "services:relay",
      "attachments:write",
    ],
    ["fixture-echo"],
  );
  const key = issueMachineKey(PEPPER);
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes: [],
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  // The same principal, but through a key that lacks attachments:write.
  const relayOnly = issueMachineKey(PEPPER);
  await store.insertMachineKey({
    id: relayOnly.id,
    principalId: principal.id,
    secretDigest: relayOnly.secretDigest,
    scopes: ["workspaces:create", "workspaces:read", "services:relay"],
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  const parsed = fixtureTemplateEcho();
  await store.upsertTemplate({
    name: parsed.manifest.metadata.name,
    version: parsed.manifest.spec.version,
    digest: parsed.digest,
    description: null,
    spec: parsed.manifest.spec,
  });
  const built = buildServer({
    store,
    driver,
    pepper: PEPPER,
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:0",
  });
  return { ...built, store, token: key.token, relayOnlyToken: relayOnly.token };
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  };
}

export async function readyWorkspace(server: TestServer): Promise<string> {
  const res = await server.app.request(
    "/v1/workspaces",
    authed(server.token, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ external_id: randomUUID(), template: { name: "fixture-echo" } }),
    }),
  );
  const ws = (await res.json()) as { id: string };
  await server.scheduler.tick();
  const now = new Date();
  await server.store.transition(ws.id, { from: ["provisioning"], to: "connected", at: now });
  await server.store.transition(ws.id, {
    from: ["connected"],
    to: "ready",
    at: now,
    patch: { readyAt: now, lastActivityAt: now },
  });
  return ws.id;
}

interface FakeUpload {
  attachmentId: string;
  name: string;
  mediaType: string;
  declared: number;
  received: Buffer[];
}

// An in-memory stand-in for the supervisor's attachment manager, driven by
// the frames the hub sends over the (fake) socket.
export function fakeAgent(
  server: TestServer,
  workspaceId: string,
  protocolVersion: ProtocolVersion = 3,
) {
  const stored = new Map<string, AttachmentDescriptor>();
  const ops = new Map<string, FakeUpload>();
  const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const proxied: Array<{ path: string; body: unknown }> = [];
  const connId = randomUUID();

  const finishUpload = (
    conn: NonNullable<ReturnType<TestServer["hub"]["get"]>>,
    op: FakeUpload,
    operationId: string,
  ) => {
    const bytes = Buffer.concat(op.received);
    const descriptor: AttachmentDescriptor = {
      id: op.attachmentId,
      name: op.name,
      path: `/home/pocketcoder/.pcd/attachments/${op.attachmentId}/${op.name}`,
      media_type: op.mediaType,
      size_bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const existing = stored.get(op.attachmentId);
    if (!existing) stored.set(op.attachmentId, descriptor);
    const identical = existing?.sha256 === descriptor.sha256;
    server.hub.pushAttachment(conn, {
      kind: "result",
      payload: {
        operation_id: operationId,
        status: existing ? (identical ? "existing" : "conflict") : "created",
        descriptor: existing && identical ? existing : descriptor,
      },
    });
  };

  const respond = (frame: { type: string; payload: Record<string, unknown> }) => {
    const conn = server.hub.get(workspaceId);
    if (!conn) return;
    const payload = frame.payload;
    const operationId = payload.operation_id as string;
    const op = ops.get(operationId);
    switch (frame.type) {
      case "attachment_start":
        ops.set(operationId, {
          attachmentId: payload.attachment_id as string,
          name: payload.name as string,
          mediaType: payload.media_type as string,
          declared: payload.size_bytes as number,
          received: [],
        });
        return;
      case "attachment_chunk": {
        if (!op) return;
        op.received.push(Buffer.from(payload.content_b64 as string, "base64"));
        server.hub.pushAttachment(conn, {
          kind: "ack",
          payload: {
            operation_id: operationId,
            seq: payload.seq as number,
            received_bytes: Buffer.concat(op.received).byteLength,
          },
        });
        return;
      }
      case "attachment_finish":
        if (op) finishUpload(conn, op, operationId);
        return;
      case "attachment_resolve": {
        const ids = payload.attachment_ids as string[];
        const missing = ids.find((id) => !stored.has(id));
        server.hub.pushAttachment(conn, {
          kind: "resolved",
          payload: missing
            ? { operation_id: operationId, missing_id: missing }
            : {
                operation_id: operationId,
                descriptors: ids.map((id) => stored.get(id) as AttachmentDescriptor),
              },
        });
        return;
      }
      case "proxy_request": {
        proxied.push({
          path: payload.path as string,
          body: payload.body_b64
            ? JSON.parse(Buffer.from(payload.body_b64 as string, "base64").toString("utf8"))
            : undefined,
        });
        server.hub.resolveRelay(conn, {
          request_id: payload.request_id as string,
          status: 200,
          headers: { "content-type": "application/json" },
          body_b64: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
        });
        return;
      }
    }
  };

  const ws = {
    send: (data: string) => {
      const frame = JSON.parse(data) as { type: string; payload: Record<string, unknown> };
      frames.push(frame);
      queueMicrotask(() => respond(frame));
    },
    close: () => {},
  } as unknown as WSContext;
  const conn = server.hub.attach(workspaceId, connId, 1, ws, protocolVersion);
  conn.registered = true;
  return { conn, stored, frames, proxied };
}

export function uploadRequest(
  token: string,
  bytes: Uint8Array,
  overrides: Record<string, string> = {},
): RequestInit {
  return authed(token, {
    method: "PUT",
    headers: {
      "content-type": "text/plain",
      "content-disposition": 'attachment; filename="notes.txt"',
      "content-length": String(bytes.byteLength),
      ...overrides,
    },
    body: bytes,
  });
}
