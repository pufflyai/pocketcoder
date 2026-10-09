import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { createRegistryResolver } from "./registry-resolver";
import { createSecretVault } from "./secret-vault";

const createStore = createTestStoreFactory();

test("registry resolution checks purpose, current retirement and the image registry", async () => {
  const store = await createStore();
  const principal = await store.createPrincipal("operator", ["admin"], []);
  const key = issueMachineKey("registry-test");
  await store.insertMachineKey({
    id: key.id,
    principalId: principal.id,
    secretDigest: key.secretDigest,
    scopes: ["admin"],
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  });
  const vault = createSecretVault(store, randomBytes(32));
  const resolve = createRegistryResolver(vault);
  const credential = { server: "registry.example:5000", username: "operator", password: "controller-only" };
  await vault.put(key.id, "private-image", { type: "registry", value: credential });
  const image = `registry.example:5000/workspace@sha256:${"a".repeat(64)}`;
  expect(await resolve("secretRef:private-image", image)).toEqual(credential);
  await expect(
    resolve("secretRef:private-image", image.replace("registry.example:5000", "other.example")),
  ).rejects.toMatchObject({ code: "secret.unavailable" });
  await expect(resolve("secretRef:private-image", `workspace@sha256:${"a".repeat(64)}`)).rejects.toMatchObject({
    code: "secret.unavailable",
  });
  await expect(resolve("secretRef:missing", image)).rejects.toMatchObject({ code: "secret.unavailable" });
  await vault.retire(key.id, "private-image");
  await expect(resolve("secretRef:private-image", image)).rejects.toMatchObject({ code: "secret.unavailable" });
});
