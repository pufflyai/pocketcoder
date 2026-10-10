import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ManagerStore } from "./store";

const stores: ManagerStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});
async function readyAccount() {
  const store = await ManagerStore.create();
  stores.push(store);
  const result = await store.createAccount(
    randomUUID(),
    { name: "bootstrap" },
    { controllerImage: `controller.test/server@sha256:${"a".repeat(64)}`, runtimeClassName: "pc-runc" },
    new Date(Date.now() + 60_000),
  );
  await store.finishAccount(result.account.id, result.operation.id);
  return { store, accountId: result.account.id };
}
test("expired uncertain bootstrap admits an explicit replacement", async () => {
  const { store, accountId } = await readyAccount();
  const request = { request_id: randomUUID(), expires_at: new Date(Date.now() + 50).toISOString() };
  const authority = new Date(Date.now() + 60_000);
  await store.beginBootstrap(accountId, request, authority);
  await Bun.sleep(70);
  const replacement = await store.beginBootstrap(
    accountId,
    { request_id: randomUUID(), expires_at: authority.toISOString(), replaces_request_id: request.request_id },
    authority,
  );
  expect(replacement.replacesRequestId).toBe(request.request_id);
  expect(replacement.state).toBe("pending");
});
test("reconciling pending issuance cannot exceed the current operator expiry", async () => {
  const { store, accountId } = await readyAccount();
  const request = { request_id: randomUUID(), expires_at: new Date(Date.now() + 60_000).toISOString() };
  await store.beginBootstrap(accountId, request, new Date(Date.now() + 120_000));
  await expect(store.beginBootstrap(accountId, request, new Date(Date.now() + 30_000))).rejects.toThrow(
    "bootstrap_expiry_invalid",
  );
});
