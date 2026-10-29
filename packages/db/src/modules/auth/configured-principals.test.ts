import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "../../test-fixtures";

const createStore = createTestStoreFactory();

test("a configured principal is created with its stable ID, then updated in place", async () => {
  const store = await createStore();
  const id = randomUUID();
  const input = { id, name: "backend", scopes: ["workspaces:read"], templateNames: ["echo"], disabled: false };
  expect(await store.applyConfiguredPrincipal(input)).toMatchObject({ id, name: "backend", disabledAt: null });
  const updated = await store.applyConfiguredPrincipal({ ...input, scopes: ["workspaces:create", "workspaces:read"] });
  expect(updated).toMatchObject({ id, scopes: ["workspaces:create", "workspaces:read"], templateNames: ["echo"] });
  expect((await store.listPrincipals()).filter((row) => row.name === "backend")).toHaveLength(1);
});

test("disabling a configured principal revokes its keys and keeps the row", async () => {
  const store = await createStore();
  const id = randomUUID();
  const input = { id, name: "backend", scopes: ["workspaces:read"], templateNames: [], disabled: false };
  await store.applyConfiguredPrincipal(input);
  const keyId = randomUUID();
  await store.insertMachineKey({
    id: keyId,
    principalId: id,
    secretDigest: new Uint8Array([1]),
    scopes: ["workspaces:read"],
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const disabled = await store.applyConfiguredPrincipal({ ...input, disabled: true });
  expect(disabled.disabledAt).toBeInstanceOf(Date);
  expect((await store.getMachineKeyWithPrincipal(keyId))?.key.revokedAt).toBeInstanceOf(Date);
  expect((await store.applyConfiguredPrincipal(input)).disabledAt).toBeNull();
});

test("a configured principal cannot take a name an unmanaged principal holds", async () => {
  const store = await createStore();
  await store.createPrincipal("backend", ["workspaces:read"], []);
  await expect(
    store.applyConfiguredPrincipal({
      id: randomUUID(),
      name: "backend",
      scopes: ["workspaces:read"],
      templateNames: [],
      disabled: false,
    }),
  ).rejects.toMatchObject({ code: "principal.name_conflict" });
});
