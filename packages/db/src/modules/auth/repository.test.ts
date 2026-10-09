import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "../../test-fixtures";

const createStore = createTestStoreFactory();

describe("principal updates", () => {
  test("updates the principal without widening explicit key restrictions", async () => {
    const store = await createStore();
    const principal = await store.createPrincipal(
      "scope-test",
      ["templates:read", "workspaces:read"],
      ["old-template"],
    );
    const restrictedKeyId = randomUUID();
    await store.insertMachineKey({
      id: restrictedKeyId,
      principalId: principal.id,
      secretDigest: new Uint8Array([1]),
      scopes: ["templates:read"],
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });

    const updated = await store.updatePrincipal(principal.id, ["workspaces:read"], ["new-template"]);

    expect(updated).toMatchObject({
      scopes: ["workspaces:read"],
      templateNames: ["new-template"],
    });
    expect((await store.getMachineKeyWithPrincipal(restrictedKeyId))?.key.scopes).toEqual(["templates:read"]);
  });
});
