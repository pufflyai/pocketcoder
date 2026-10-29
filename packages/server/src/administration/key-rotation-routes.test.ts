import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { KeyIssueResponseSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { createPrincipalKeyServer } from "./principal-test-fixtures";

const createStore = createTestStoreFactory();

async function rotationServer() {
  const app = await createPrincipalKeyServer(await createStore());
  const issued = await app.request(`/v1/principals/${app.customer.id}/keys`, {
    method: "POST",
    body: JSON.stringify({
      request_id: "backend-current",
      scopes: ["workspaces:read"],
      expires_at: new Date(app.expiresAt.getTime() - 600_000).toISOString(),
    }),
  });
  const current = KeyIssueResponseSchema.parse(await issued.json());
  const rotate = (keyId: string, body: Record<string, unknown>, token?: string) =>
    app.app.request(
      `/v1/principals/${app.customer.id}/keys/${keyId}/rotate`,
      authed(token ?? "", { method: "POST", body: JSON.stringify(body) }),
    );
  return { ...app, current, rotate };
}

test("a consumer switches to a successor key and the old key is revoked without a failed request", async () => {
  const app = await rotationServer();
  const asConsumer = (token: string) => app.app.request("/v1/workspaces", authed(token));
  const response = await app.request(`/v1/principals/${app.customer.id}/keys/${app.current.key.id}/rotate`, {
    method: "POST",
    body: JSON.stringify({ request_id: "backend-next" }),
  });
  expect(response.status).toBe(201);
  const successor = KeyIssueResponseSchema.parse(await response.json());
  expect(successor.key).toMatchObject({ principal_id: app.customer.id, scopes: ["workspaces:read"] });

  // Both keys work while the consumer rolls over.
  expect((await asConsumer(app.current.token ?? "")).status).toBe(200);
  expect((await asConsumer(successor.token ?? "")).status).toBe(200);
  const revoke = await app.request(`/v1/principals/${app.customer.id}/keys/${app.current.key.id}`, {
    method: "DELETE",
  });
  expect(revoke.status).toBe(200);
  expect((await asConsumer(successor.token ?? "")).status).toBe(200);
  expect((await asConsumer(app.current.token ?? "")).status).toBe(401);
});

test("a dedicated automation key rotates only the principals it manages", async () => {
  const app = await rotationServer();
  const automation = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: automation.id,
    principalId: app.owner.id,
    secretDigest: automation.secretDigest,
    scopes: ["keys:read", "keys:write"],
    managedPrincipalIds: [app.customer.id],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 1_800_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const rotated = await app.rotate(app.current.key.id, { request_id: "automation-next" }, automation.token);
  expect(rotated.status).toBe(201);
  const body = KeyIssueResponseSchema.parse(await rotated.json());
  // The successor cannot outlive the automation key that issued it.
  expect(new Date(body.key.expires_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now() + 1_800_000);

  const ownerKeys = await app.store.listMachineKeys(app.owner.id, { limit: 10 });
  const ownerKey = ownerKeys.find((key) => key.id !== automation.id);
  const denied = await app.app.request(
    `/v1/principals/${app.owner.id}/keys/${ownerKey?.id}/rotate`,
    authed(automation.token, { method: "POST", body: JSON.stringify({ request_id: "steal-owner" }) }),
  );
  expect(denied.status).toBe(404);
});

test("the SDK rotates a key through the public server", async () => {
  const app = await rotationServer();
  const server = Bun.serve({ port: 0, fetch: app.app.fetch });
  try {
    const client = new PocketCoderClient({ baseUrl: server.url.toString(), apiKey: app.ownerToken });
    const rotated = await client.keys.rotate(app.customer.id, app.current.key.id, { request_id: "sdk-next" });
    expect(rotated.token).toStartWith("pkt_");
    const replay = await client.keys.rotate(app.customer.id, app.current.key.id, { request_id: "sdk-next" });
    expect(replay).toMatchObject({ token: null, key: { id: rotated.key.id } });
  } finally {
    server.stop(true);
  }
});
