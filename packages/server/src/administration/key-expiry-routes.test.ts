import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { ExpiringKeyListResponseSchema } from "@pstdio/pocketcoder-contracts";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import { authed, SERVER_TEST_PEPPER } from "../testing/test-server.test";
import { createPrincipalKeyServer } from "./principal-test-fixtures";

const createStore = createTestStoreFactory();
const DAY = 86_400_000;

async function expiryServer() {
  const app = await createPrincipalKeyServer(await createStore());
  const insert = async (principalId: string, expiresAt: Date, extra: { managedPrincipalIds?: string[] } = {}) => {
    const key = issueMachineKey(SERVER_TEST_PEPPER);
    await app.store.insertMachineKey({
      id: key.id,
      principalId,
      secretDigest: key.secretDigest,
      scopes: principalId === app.owner.id ? ["keys:read", "keys:write"] : ["workspaces:read"],
      createdAt: new Date(),
      expiresAt,
      revokedAt: null,
      lastUsedAt: null,
      ...extra,
    });
    return key;
  };
  const sevenDays = await insert(app.customer.id, new Date(Date.now() + 7 * DAY - 60_000));
  const thirtyDays = await insert(app.customer.id, new Date(Date.now() + 30 * DAY));
  return { ...app, insert, sevenDays, thirtyDays };
}

test("a key seven days from expiry is listed as expiring", async () => {
  const app = await expiryServer();
  const response = await app.request("/v1/keys/expiring?within_hours=168");
  expect(response.status).toBe(200);
  const body = ExpiringKeyListResponseSchema.parse(await response.json());
  const ids = body.items.map((item) => item.id);
  expect(ids).toContain(app.sevenDays.id);
  expect(ids).not.toContain(app.thirtyDays.id);
  expect(body.items.find((item) => item.id === app.sevenDays.id)?.principal_name).toBe("customer");
  expect(JSON.stringify(body)).not.toContain("pkt_");
});

test("the metric reports the earliest active expiry per principal", async () => {
  const app = await expiryServer();
  const response = await app.request("/v1/keys/metrics");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("text/plain");
  const text = await response.text();
  const expiry = (await app.store.getMachineKeyWithPrincipal(app.sevenDays.id))?.key.expiresAt ?? new Date(0);
  expect(text).toContain("# TYPE pocketcoder_principal_key_earliest_expiry_seconds gauge");
  expect(text).toContain(
    `pocketcoder_principal_key_earliest_expiry_seconds{principal_id="${app.customer.id}",principal_name="customer"} ${expiry.getTime() / 1000}`,
  );
});

test("an automation key sees only the principals it manages", async () => {
  const app = await expiryServer();
  const other = await app.store.createPrincipal("other", ["workspaces:read"], []);
  const hidden = await app.insert(other.id, new Date(Date.now() + DAY));
  const automation = await app.insert(app.owner.id, new Date(Date.now() + 2 * DAY), {
    managedPrincipalIds: [app.customer.id],
  });
  const listed = ExpiringKeyListResponseSchema.parse(
    await (await app.app.request("/v1/keys/expiring", authed(automation.token))).json(),
  );
  expect(listed.items.map((item) => item.principal_id)).toEqual([app.customer.id]);
  const metrics = await (await app.app.request("/v1/keys/metrics", authed(automation.token))).text();
  expect(metrics).not.toContain(other.id);
  expect(metrics).not.toContain(hidden.id);
});

test("the SDK lists expiring keys", async () => {
  const app = await expiryServer();
  const server = Bun.serve({ port: 0, fetch: app.app.fetch });
  try {
    const client = new PocketCoderClient({ baseUrl: server.url.toString(), apiKey: app.ownerToken });
    const result = await client.keys.expiring({ withinHours: 24 * 8 });
    expect(result.items.map((item) => item.id)).toContain(app.sevenDays.id);
  } finally {
    server.stop(true);
  }
});
