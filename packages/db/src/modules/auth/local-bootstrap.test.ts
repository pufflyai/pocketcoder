import { expect, test } from "bun:test";
import { bootstrapLocalOwnerKey, bootstrapLocalRecoveryKey } from "@pstdio/pocketcoder-runtime-core";
import { createTestStoreFactory } from "../../test-fixtures";

const createStore = createTestStoreFactory();
const pepper = "local-bootstrap-test-pepper";

test("local owner bootstrap issues bounded admin once and replaces authority atomically", async () => {
  const store = await createStore();
  const input = { request_id: "first-owner", expires_at: new Date(Date.now() + 86_400_000).toISOString() };
  const first = await bootstrapLocalOwnerKey(store, pepper, input);
  expect(first.token).toStartWith("pkt_");
  expect(first.key).toMatchObject({ scopes: ["admin"], effective_templates: ["*"], expires_at: input.expires_at });
  const replay = await bootstrapLocalOwnerKey(store, pepper, input);
  expect(replay).toMatchObject({ key: { id: first.key.id }, token: null });
  await expect(
    bootstrapLocalOwnerKey(store, pepper, { ...input, expires_at: new Date(Date.now() + 1000).toISOString() }),
  ).rejects.toMatchObject({ code: "idempotency.conflict" });
  const replacement = await bootstrapLocalOwnerKey(store, pepper, { ...input, request_id: "replace-owner" }, true);
  expect(replacement.token).toStartWith("pkt_");
  expect(replacement.key.principal_id).toBe(first.key.principal_id);
  expect((await store.getMachineKeyWithPrincipal(first.key.id))?.key.revokedAt).toBeInstanceOf(Date);
  expect((await store.getMachineKeyWithPrincipal(replacement.key.id))?.key.revokedAt).toBeNull();
});

test("local recovery bootstrap has the same bounded scopes and exact targets as HTTP", async () => {
  const store = await createStore();
  const expires_at = new Date(Date.now() + 60_000).toISOString();
  const owner = await bootstrapLocalOwnerKey(store, pepper, { request_id: "owner", expires_at });
  const customer = await store.createPrincipal("customer", ["workspaces:read"], ["fixture-echo"]);
  const input = {
    request_id: "recovery",
    expires_at,
    scopes: ["keys:read", "keys:write", "workspaces:recover"] as const,
    templates: ["fixture-echo"],
    managed_principal_ids: [customer.id],
  };
  const recovery = await bootstrapLocalRecoveryKey(store, pepper, owner.key.principal_id, {
    ...input,
    scopes: [...input.scopes],
  });
  expect(recovery.token).toStartWith("pkt_");
  expect(recovery.key).toMatchObject({ managed_principal_ids: [customer.id], templates: ["fixture-echo"], expires_at });
  await expect(
    bootstrapLocalRecoveryKey(store, pepper, owner.key.principal_id, { ...input, scopes: ["admin"] }),
  ).rejects.toMatchObject({ code: "auth.missing_scope" });
  await expect(
    bootstrapLocalRecoveryKey(store, pepper, owner.key.principal_id, {
      ...input,
      scopes: [...input.scopes],
      managed_principal_ids: [crypto.randomUUID()],
    }),
  ).rejects.toMatchObject({ code: "principal.not_found" });
  await expect(
    bootstrapLocalOwnerKey(store, pepper, { request_id: "expired", expires_at: new Date(0).toISOString() }),
  ).rejects.toMatchObject({ code: "validation.invalid" });
});
