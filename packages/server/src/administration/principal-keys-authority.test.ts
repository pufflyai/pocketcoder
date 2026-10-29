import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { KeyIssueResponseSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { authed, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { createPrincipalKeyServer } from "./principal-test-fixtures";

const createStore = createTestStoreFactory();
async function ownerServer() {
  return createPrincipalKeyServer(await createStore());
}

test("owner HTTP issuance creates bounded recovery keys for exact targets", async () => {
  const app = await ownerServer();
  const response = await app.request(`/v1/principals/${app.owner.id}/keys`, {
    method: "POST",
    body: JSON.stringify({
      request_id: "recovery-bootstrap",
      scopes: ["keys:read", "keys:write", "workspaces:recover"],
      templates: ["fixture-echo"],
      managed_principal_ids: [app.customer.id],
      expires_at: new Date(Date.now() + 1800000).toISOString(),
    }),
  });
  expect(response.status).toBe(201);
  const body = KeyIssueResponseSchema.parse(await response.json());
  expect(body.token).toStartWith("pkt_");
  expect(body.key).toMatchObject({ managed_principal_ids: [app.customer.id], templates: ["fixture-echo"] });
  const inventory = await app.app.request(`/v1/principals/${app.customer.id}/keys`, authed(body.token ?? ""));
  expect(inventory.status).toBe(200);
  expect((await app.app.request(`/v1/principals/${app.owner.id}/keys`, authed(body.token ?? ""))).status).toBe(404);
});

test("issuance cannot extend a calling key's remaining lifetime", async () => {
  const app = await ownerServer();
  const response = await app.request(`/v1/principals/${app.customer.id}/keys`, {
    method: "POST",
    body: JSON.stringify({
      request_id: "extended",
      scopes: ["workspaces:read"],
      templates: ["fixture-echo"],
      expires_at: new Date(app.expiresAt.getTime() + 1).toISOString(),
    }),
  });
  expect(response.status).toBe(403);
  expect(await app.store.listMachineKeys(app.customer.id, { limit: 10 })).toEqual([]);
});

function keyRequest(app: Awaited<ReturnType<typeof ownerServer>>, requestId: string) {
  return {
    request_id: requestId,
    scopes: ["workspaces:read"],
    templates: ["fixture-echo"],
    expires_at: new Date(app.expiresAt.getTime() - 60_000).toISOString(),
  };
}

test("owner recovery issuance rejects nonexistent managed targets", async () => {
  const app = await ownerServer();
  const response = await app.request(`/v1/principals/${app.owner.id}/keys`, {
    method: "POST",
    body: JSON.stringify({
      ...keyRequest(app, "unknown-target"),
      scopes: ["keys:read", "keys:write", "workspaces:recover"],
      managed_principal_ids: [crypto.randomUUID()],
    }),
  });
  expect(response.status).toBe(404);
  expect(await app.store.listMachineKeys(app.owner.id, { limit: 10, requestId: "unknown-target" })).toEqual([]);
});

test("a delegated recovery key cannot issue credentials for a stronger administrative target", async () => {
  const app = await ownerServer();
  const recovery = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: recovery.id,
    principalId: app.owner.id,
    secretDigest: recovery.secretDigest,
    scopes: ["keys:read", "keys:write", "workspaces:recover"],
    templateNames: ["fixture-echo"],
    managedPrincipalIds: [app.owner.id],
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const response = await app.app.request(
    `/v1/principals/${app.owner.id}/keys`,
    authed(recovery.token, {
      method: "POST",
      body: JSON.stringify(keyRequest(app, "stronger-owner")),
    }),
  );
  expect(response.status).toBe(403);
  expect(await app.store.listMachineKeys(app.owner.id, { limit: 10, requestId: "stronger-owner" })).toEqual([]);
});

async function restrictedKey(
  app: Awaited<ReturnType<typeof ownerServer>>,
  scopes: string[],
  templates = ["fixture-echo"],
) {
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: app.owner.id,
    secretDigest: key.secretDigest,
    scopes,
    templateNames: templates,
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  return (path: string, body: unknown) =>
    app.app.request(
      path,
      authed(key.token, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
}

test("restricted owner keys check caller scopes, target grants and template wildcard escalation", async () => {
  const app = await ownerServer();
  const request = await restrictedKey(app, ["keys:write", "workspaces:read", "workspaces:create"]);
  const path = `/v1/principals/${app.customer.id}/keys`;
  const valid = keyRequest(app, "restricted");
  expect((await request(path, valid)).status).toBe(201);
  for (const [id, body, status] of [
    [app.owner.id, { ...valid, request_id: "stronger" }, 404],
    [app.customer.id, { ...valid, request_id: "wildcard", templates: ["*"] }, 403],
    [app.customer.id, { ...valid, request_id: "caller-scope", scopes: ["workspaces:purge"] }, 403],
    [app.customer.id, { ...valid, request_id: "delegation", managed_principal_ids: [app.customer.id] }, 403],
  ] as const) {
    expect((await request(`/v1/principals/${id}/keys`, body)).status).toBe(status);
  }
  const readOnly = await app.store.createPrincipal("read-only-target", ["workspaces:read"], ["fixture-echo"]);
  expect(
    (
      await request(`/v1/principals/${readOnly.id}/keys`, {
        ...valid,
        request_id: "target-scope",
        scopes: ["workspaces:create"],
      })
    ).status,
  ).toBe(403);
});

test("principals:admin alone cannot mint keys, admin or recovery authority", async () => {
  const app = await ownerServer();
  const request = await restrictedKey(app, ["principals:admin"]);
  for (const scopes of [["workspaces:read"], ["admin"], ["keys:write", "workspaces:recover"]]) {
    expect(
      (
        await request(`/v1/principals/${app.customer.id}/keys`, {
          ...keyRequest(app, scopes.join("-")),
          scopes,
          managed_principal_ids: [app.customer.id],
        })
      ).status,
    ).toBe(403);
  }
});

test("owner admin issuance remains finite and request identity includes template and target grants", async () => {
  const app = await ownerServer();
  const path = `/v1/principals/${app.owner.id}/keys`;
  const input = { ...keyRequest(app, "owner-admin"), scopes: ["admin"] };
  const issued = KeyIssueResponseSchema.parse(
    await (
      await app.request(path, {
        method: "POST",
        body: JSON.stringify(input),
      })
    ).json(),
  );
  expect(issued.token).toStartWith("pkt_");
  expect(issued.key.expires_at).toBe(input.expires_at);
  expect(
    KeyIssueResponseSchema.parse(
      await (
        await app.request(path, {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).json(),
    ).token,
  ).toBeNull();
  expect(
    (
      await app.request(path, {
        method: "POST",
        body: JSON.stringify({ ...input, templates: [] }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await app.request(path, {
        method: "POST",
        body: JSON.stringify({ ...input, expires_at: null }),
      })
    ).status,
  ).toBe(400);

  const recoveryInput = {
    ...keyRequest(app, "immutable-recovery"),
    scopes: ["keys:read", "keys:write", "workspaces:recover"],
    managed_principal_ids: [app.customer.id],
  };
  expect((await app.request(path, { method: "POST", body: JSON.stringify(recoveryInput) })).status).toBe(201);
  expect(
    (
      await app.request(path, {
        method: "POST",
        body: JSON.stringify({ ...recoveryInput, managed_principal_ids: [] }),
      })
    ).status,
  ).toBe(409);
});

test("disable and concurrent issuance leave no keys usable for the disabled target", async () => {
  const app = await ownerServer();
  const path = `/v1/principals/${app.customer.id}`;
  const [issued, disabled] = await Promise.all([
    app.request(`${path}/keys`, { method: "POST", body: JSON.stringify(keyRequest(app, "concurrent-disable")) }),
    app.request(path, { method: "PATCH", body: JSON.stringify({ disabled: true }) }),
  ]);
  expect([201, 403]).toContain(issued.status);
  expect(disabled.status).toBe(200);
  expect((await app.store.listMachineKeys(app.customer.id, { limit: 10 })).every((key) => key.revokedAt)).toBe(true);
  expect(
    (
      await app.request(`${path}/keys`, {
        method: "POST",
        body: JSON.stringify(keyRequest(app, "after-disable")),
      })
    ).status,
  ).toBe(403);
});

test("revoking a calling key serializes with issuance and blocks later requests", async () => {
  const app = await ownerServer();
  const issuer = await app.store.createPrincipal(
    "issuer",
    ["keys:write", "workspaces:read", "workspaces:create"],
    ["fixture-echo"],
  );
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: issuer.id,
    secretDigest: key.secretDigest,
    scopes: issuer.scopes,
    templateNames: issuer.templateNames,
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const issue = (requestId: string) =>
    app.app.request(
      `/v1/principals/${app.customer.id}/keys`,
      authed(key.token, {
        method: "POST",
        body: JSON.stringify(keyRequest(app, requestId)),
      }),
    );
  const [issued, revoked] = await Promise.all([
    issue("during-revoke"),
    app.request(`/v1/principals/${issuer.id}/keys/${key.id}`, { method: "DELETE" }),
  ]);
  expect([201, 401]).toContain(issued.status);
  expect(revoked.status).toBe(200);
  expect((await issue("after-revoke")).status).toBe(401);
  expect(await app.store.listMachineKeys(app.customer.id, { limit: 10, requestId: "after-revoke" })).toEqual([]);
});

test("a constrained issuer can issue existing key scopes without delegation", async () => {
  const app = await ownerServer();
  const issuer = await app.store.createPrincipal(
    "constrained-key-issuer",
    ["keys:write", "keys:read"],
    ["fixture-echo"],
  );
  const target = await app.store.createPrincipal("key-reader", ["keys:read"], ["fixture-echo"]);
  const key = issueMachineKey(SERVER_TEST_PEPPER);
  await app.store.insertMachineKey({
    id: key.id,
    principalId: issuer.id,
    secretDigest: key.secretDigest,
    scopes: issuer.scopes,
    templateNames: issuer.templateNames,
    createdAt: new Date(),
    expiresAt: app.expiresAt,
    revokedAt: null,
    lastUsedAt: null,
  });
  const response = await app.app.request(
    `/v1/principals/${target.id}/keys`,
    authed(key.token, {
      method: "POST",
      body: JSON.stringify({ ...keyRequest(app, "bounded-key-scope"), scopes: ["keys:read"] }),
    }),
  );
  expect(response.status).toBe(201);
  expect(KeyIssueResponseSchema.parse(await response.json()).key).toMatchObject({
    effective_scopes: ["keys:read"],
    managed_principal_ids: [],
  });
});

test("an owner can issue a bounded recovery key on a dedicated recovery principal", async () => {
  const app = await ownerServer();
  const recovery = await app.store.createPrincipal(
    "dedicated-recovery",
    ["keys:read", "keys:write", "workspaces:recover"],
    ["fixture-echo"],
  );
  const response = await app.request(`/v1/principals/${recovery.id}/keys`, {
    method: "POST",
    body: JSON.stringify({
      ...keyRequest(app, "dedicated-recovery"),
      scopes: recovery.scopes,
      managed_principal_ids: [app.customer.id],
    }),
  });
  expect(response.status).toBe(201);
  const body = KeyIssueResponseSchema.parse(await response.json());
  expect(body.key).toMatchObject({ effective_scopes: recovery.scopes, managed_principal_ids: [app.customer.id] });
  expect((await app.app.request(`/v1/principals/${app.customer.id}/keys`, authed(body.token ?? ""))).status).toBe(200);
  expect((await app.app.request(`/v1/principals/${app.owner.id}/keys`, authed(body.token ?? ""))).status).toBe(404);
});
