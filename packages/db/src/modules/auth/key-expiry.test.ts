import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createTestStoreFactory } from "../../test-fixtures";

const createStore = createTestStoreFactory();
const DAY = 86_400_000;

async function key(
  store: Awaited<ReturnType<typeof createStore>>,
  principalId: string,
  expiresAt: Date | null,
  revokedAt: Date | null = null,
) {
  const id = randomUUID();
  await store.insertMachineKey({
    id,
    principalId,
    secretDigest: new Uint8Array([1]),
    scopes: [],
    createdAt: new Date(),
    expiresAt,
    revokedAt,
    lastUsedAt: null,
  });
  return id;
}

test("active key expiries skip revoked, expired, unbounded and disabled-principal keys", async () => {
  const store = await createStore();
  const now = new Date();
  const backend = await store.createPrincipal("backend", ["workspaces:read"], []);
  const disabled = await store.createPrincipal("disabled", ["workspaces:read"], []);
  const soon = await key(store, backend.id, new Date(now.getTime() + 2 * DAY));
  const later = await key(store, backend.id, new Date(now.getTime() + 30 * DAY));
  await key(store, backend.id, new Date(now.getTime() + DAY), now);
  await key(store, backend.id, new Date(now.getTime() - DAY));
  await key(store, backend.id, null);
  await key(store, disabled.id, new Date(now.getTime() + DAY));
  await store.setPrincipalDisabled(disabled.id, true);

  const all = await store.listActiveMachineKeys(now);
  expect(all.map((row) => row.key.id)).toEqual([soon, later]);
  expect(all[0]?.principal.name).toBe("backend");
  const within = await store.listActiveMachineKeys(now, new Date(now.getTime() + 7 * DAY));
  expect(within.map((row) => row.key.id)).toEqual([soon]);
});
