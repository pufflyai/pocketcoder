import { expect, test } from "bun:test";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { issuePrincipalKey } from "./key-administration";
import { rotatePrincipalKey, successorExpiry } from "./key-rotation";

const createStore = createTestStoreFactory();
const pepper = "key-rotation-test-pepper";
const HOUR = 3_600_000;

test("a successor keeps the predecessor's lifetime but never outlives its issuer", () => {
  const now = new Date("2026-10-29T00:00:00Z");
  const predecessor = { createdAt: new Date(now.getTime() - 20 * HOUR), expiresAt: new Date(now.getTime() + 4 * HOUR) };
  expect(successorExpiry(predecessor, null, now)).toEqual(new Date(now.getTime() + 24 * HOUR));
  const issuer = new Date(now.getTime() + 10 * HOUR);
  expect(successorExpiry(predecessor, issuer, now)).toEqual(issuer);
});

async function fixture() {
  const store = await createStore();
  const owner = await store.createPrincipal("owner", ["admin"], ["*"]);
  const backend = await store.createPrincipal("backend", ["workspaces:read", "workspaces:create"], ["echo"]);
  const issue = (principal: typeof owner, request_id: string, scopes: string[], expiresIn: number, actor?: string) =>
    issuePrincipalKey(
      store,
      pepper,
      principal,
      { request_id, scopes: scopes as never, expires_at: new Date(Date.now() + expiresIn).toISOString() },
      { operatorBootstrap: true, ...(actor ? { actorKeyId: actor } : {}) },
    );
  const ownerKey = await issue(owner, "owner", ["admin"], 48 * HOUR);
  const current = await issue(backend, "current", ["workspaces:read"], 12 * HOUR, ownerKey.key.id);
  return { store, owner, backend, ownerKey, current };
}

test("rotation issues a successor with the same grants while the current key stays valid", async () => {
  const f = await fixture();
  const rotated = await rotatePrincipalKey(
    f.store,
    pepper,
    f.backend,
    f.current.key.id,
    { request_id: "rotate-1" },
    { actorKeyId: f.ownerKey.key.id },
  );
  expect(rotated.created).toBe(true);
  expect(rotated.token).toStartWith("pkt_");
  expect(rotated.key).toMatchObject({ principal_id: f.backend.id, scopes: ["workspaces:read"], templates: ["echo"] });
  const lifetime = new Date(rotated.key.expires_at ?? 0).getTime() - Date.now();
  expect(lifetime).toBeGreaterThan(11.9 * HOUR);
  expect(lifetime).toBeLessThanOrEqual(12 * HOUR);
  expect((await f.store.getMachineKeyWithPrincipal(f.current.key.id))?.key.revokedAt).toBeNull();

  // A lost response is replayed after the consumer switched and the predecessor was revoked.
  await f.store.revokeMachineKey(f.current.key.id, new Date());
  const replay = await rotatePrincipalKey(
    f.store,
    pepper,
    f.backend,
    f.current.key.id,
    { request_id: "rotate-1" },
    { actorKeyId: f.ownerKey.key.id },
  );
  expect(replay).toMatchObject({ created: false, token: null, key: { id: rotated.key.id } });
});

test("rotation caps the successor at the issuer's expiry and rejects explicit extension", async () => {
  const f = await fixture();
  const shortOwner = await issuePrincipalKey(
    f.store,
    pepper,
    f.owner,
    { request_id: "short-owner", scopes: ["admin"], expires_at: new Date(Date.now() + 2 * HOUR).toISOString() },
    { actorKeyId: f.ownerKey.key.id },
  );
  const rotated = await rotatePrincipalKey(
    f.store,
    pepper,
    f.backend,
    f.current.key.id,
    { request_id: "capped" },
    { actorKeyId: shortOwner.key.id },
  );
  expect(rotated.key.expires_at).toBe(shortOwner.key.expires_at);
  await expect(
    rotatePrincipalKey(
      f.store,
      pepper,
      f.backend,
      f.current.key.id,
      { request_id: "extended", expires_at: new Date(Date.now() + 3 * HOUR).toISOString() },
      { actorKeyId: shortOwner.key.id },
    ),
  ).rejects.toMatchObject({ code: "auth.missing_scope" });
});

test("only an active key of the named principal can be rotated", async () => {
  const f = await fixture();
  const rotate = (keyId: string, request_id: string) =>
    rotatePrincipalKey(f.store, pepper, f.backend, keyId, { request_id }, { actorKeyId: f.ownerKey.key.id });
  await expect(rotate(f.ownerKey.key.id, "other-principal")).rejects.toMatchObject({ code: "key.not_found" });
  await f.store.revokeMachineKey(f.current.key.id, new Date());
  await expect(rotate(f.current.key.id, "revoked")).rejects.toMatchObject({ code: "validation.invalid" });
});
