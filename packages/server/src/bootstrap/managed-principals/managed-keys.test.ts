import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestStoreFactory } from "@pstdio/pocketcoder-db/testing";
import { ensureManagedKey } from "./managed-keys";
import { managedPrincipalId, parsePrincipalFile } from "./principal-file";
import { secretTargetStore } from "./secret-targets";

const createStore = createTestStoreFactory();
const HOUR = 3_600_000;
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture(pepper = "managed-keys-pepper") {
  const store = await createStore();
  const directory = await mkdtemp(join(tmpdir(), "pocketcoder-managed-keys-"));
  directories.push(directory);
  const path = join(directory, "token");
  const [principal] = parsePrincipalFile(
    JSON.stringify({
      principals: [
        {
          name: "backend",
          scopes: ["workspaces:read"],
          templates: ["echo"],
          key: { lifetime_hours: 48, renew_before_hours: 12, overlap_minutes: 30, target: { kind: "file", path } },
        },
      ],
    }),
  ).principals;
  if (!principal?.key) throw new Error("fixture principal needs a key");
  const row = await store.applyConfiguredPrincipal({
    id: managedPrincipalId("backend"),
    name: "backend",
    scopes: ["workspaces:read"],
    templateNames: ["echo"],
    disabled: false,
  });
  const target = secretTargetStore(principal.key.target);
  const ensure = (now = new Date(), dryRun = false, keyPepper = pepper) =>
    ensureManagedKey({ store, pepper: keyPepper, principal: row, config: principal, target, now, dryRun });
  return { store, row, target, ensure };
}

test("a missing target gets a fresh key once, and a healthy target is kept", async () => {
  const f = await fixture();
  const planned = await f.ensure(new Date(), true);
  expect(planned).toMatchObject({ action: "issue", reason: "missing", retired: [] });
  expect(await f.target.read()).toBeNull();

  const issued = await f.ensure();
  expect(issued).toMatchObject({ action: "issue", reason: "missing" });
  const token = await f.target.read();
  expect(token).toStartWith(`pkt_${issued.keyId}_`);
  const key = (await f.store.getMachineKeyWithPrincipal(issued.keyId ?? ""))?.key;
  expect(key).toMatchObject({ scopes: ["workspaces:read"], templateNames: ["echo"] });
  expect(key?.issuanceRequestId).toStartWith("managed-");
  expect((key?.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(47.9 * HOUR);

  expect(await f.ensure()).toMatchObject({ action: "keep", reason: "healthy", keyId: issued.keyId });
  expect(await f.target.read()).toBe(token);
});

test("renewal rewrites the target and retires the old key after the overlap", async () => {
  const f = await fixture();
  const first = await f.ensure();
  const renewalTime = new Date(Date.now() + 37 * HOUR);
  const renewed = await f.ensure(renewalTime);
  expect(renewed).toMatchObject({ action: "issue", reason: "expiring", retired: [] });
  expect(await f.target.read()).toStartWith(`pkt_${renewed.keyId}_`);
  // During the overlap both keys stay valid, so a consumer that has not reloaded keeps working.
  expect((await f.store.getMachineKeyWithPrincipal(first.keyId ?? ""))?.key.revokedAt).toBeNull();

  const afterOverlap = new Date(Date.now() + 31 * 60_000);
  expect(await f.ensure(afterOverlap)).toMatchObject({ action: "keep", retired: [first.keyId] });
  expect((await f.store.getMachineKeyWithPrincipal(first.keyId ?? ""))?.key.revokedAt).toBeInstanceOf(Date);
});

test("a pepper rotation re-issues the key through the same path", async () => {
  const f = await fixture();
  await f.ensure();
  const reissued = await f.ensure(new Date(), false, "rotated-pepper");
  expect(reissued).toMatchObject({ action: "issue", reason: "pepper_changed" });
  expect(await f.ensure(new Date(), false, "rotated-pepper")).toMatchObject({ action: "keep" });
});

test("a revoked key or changed grants re-issue the key", async () => {
  const f = await fixture();
  const first = await f.ensure();
  await f.store.revokeMachineKey(first.keyId ?? "", new Date());
  const second = await f.ensure();
  expect(second).toMatchObject({ action: "issue", reason: "revoked" });
  await f.store.applyConfiguredPrincipal({
    id: f.row.id,
    name: "backend",
    scopes: ["workspaces:create", "workspaces:read"],
    templateNames: ["echo"],
    disabled: false,
  });
  // The file still declares the narrower grants, so the key matches and is kept.
  expect(await f.ensure()).toMatchObject({ action: "keep", keyId: second.keyId });
});

test("a key whose token could not be written is revoked", async () => {
  const f = await fixture();
  const failing = { ...f.target, write: async () => Promise.reject(new Error("target unavailable")) };
  const principal = parsePrincipalFile(
    JSON.stringify({
      principals: [
        {
          name: "backend",
          scopes: ["workspaces:read"],
          templates: ["echo"],
          key: { target: { kind: "file", path: "/x" } },
        },
      ],
    }),
  ).principals[0];
  if (!principal) throw new Error("fixture principal");
  await expect(
    ensureManagedKey({
      store: f.store,
      pepper: "managed-keys-pepper",
      principal: f.row,
      config: principal,
      target: failing,
      now: new Date(),
      dryRun: false,
    }),
  ).rejects.toThrow("target unavailable");
  const keys = await f.store.listMachineKeys(f.row.id, { limit: 10 });
  expect(keys).toHaveLength(1);
  expect(keys[0]?.revokedAt).toBeInstanceOf(Date);
});
