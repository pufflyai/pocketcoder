import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { createSecretVault } from "./secret-vault";

const createStore = createTestStoreFactory();
const registry = { server: "registry.example", username: "operator", password: "private-registry-password" };

async function fixture(scopes = ["secrets:write"]) {
  const store = await createStore();
  const principal = await store.createPrincipal("operator", scopes, []);
  const key = issueMachineKey("secret-test");
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const encryptionKey = randomBytes(32);
  return { store, principal, key, encryptionKey, vault: createSecretVault(store, encryptionKey) };
}

test("stored values are encrypted and public metadata never returns their values", async () => {
  const f = await fixture();
  const result = await f.vault.put(f.key.id, "pull-image", { type: "registry", value: registry });
  expect(result).toMatchObject({ name: "pull-image", type: "registry", retired_at: null });
  expect(JSON.stringify(result)).not.toContain(registry.password);
  expect(await f.vault.list(f.key.id)).toEqual([result]);
  const sealed = await f.store.readSecret("pull-image");
  if (!sealed) throw new Error("Missing stored record.");
  expect(Buffer.from(sealed.ciphertext).toString()).not.toContain(registry.password);
  expect(await f.vault.resolve("pull-image", "registry")).toMatchObject({ id: sealed.id, value: registry });
  await expect(createSecretVault(f.store, randomBytes(32)).resolve("pull-image", "registry")).rejects.toMatchObject({
    code: "secret.unavailable",
    message: "Stored secret is unavailable.",
  });
});

test("updates retain immutable encrypted versions for revocation and retirement stops new resolution", async () => {
  const f = await fixture();
  await f.vault.put(f.key.id, "pull-image", { type: "registry", value: registry });
  const first = await f.vault.resolve("pull-image", "registry");
  const replacement = { ...registry, password: "replacement-password" };
  await f.vault.put(f.key.id, "pull-image", { type: "registry", value: replacement });
  const current = await f.vault.resolve("pull-image", "registry");
  expect(current.id).not.toBe(first.id);
  expect(current.value).toEqual(replacement);
  expect(await f.vault.resolveVersion(first.id, "registry")).toEqual(first);
  const retired = await f.vault.retire(f.key.id, "pull-image");
  expect(retired.retired_at).not.toBeNull();
  expect(await f.vault.retire(f.key.id, "pull-image")).toEqual(retired);
  await expect(f.vault.resolve("pull-image", "registry")).rejects.toMatchObject({ code: "secret.unavailable" });
  expect(await f.vault.resolveVersion(first.id, "registry")).toEqual(first);
  await expect(f.vault.retire(f.key.id, "missing")).rejects.toMatchObject({ code: "secret.not_found" });
});

test("secret administration uses current instance-wide scope instead of template-name grants", async () => {
  const f = await fixture();
  await f.vault.put(f.key.id, "global-name", { type: "registry", value: registry });
  await f.store.updatePrincipal(f.principal.id, ["templates:write"], ["*"]);
  await expect(f.vault.put(f.key.id, "global-name", { type: "registry", value: registry })).rejects.toMatchObject({
    code: "auth.missing_scope",
  });
  await expect(f.vault.list(f.key.id)).rejects.toMatchObject({ code: "auth.missing_scope" });
  await expect(f.vault.retire(f.key.id, "global-name")).rejects.toMatchObject({ code: "auth.missing_scope" });
  await f.store.revokeMachineKey(f.key.id, new Date());
  await expect(f.vault.list(f.key.id)).rejects.toMatchObject({ code: "auth.invalid_key" });
});
