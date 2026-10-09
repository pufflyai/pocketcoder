import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGliteStore } from "@pstdio/pocketcoder-db";
import { createIssuerClient } from "./issuer-client";
import { createWorkspaceLeaseService } from "./lease-service";
import { leaseServiceFixture as fixture } from "./lease-service-fixture";
import { createSecretVault } from "./secret-vault";

test("HTTPS issuance persists identity first, delivers only scoped authority and revokes the captured credential", async () => {
  const f = await fixture();
  try {
    f.issuer.controls.beforeMint = async (input) => {
      const pending = await f.store.listPendingWorkspaceLeases(f.workspace.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ requestId: input.request_id, state: "requested" });
    };
    const result = await f.service.issue(f.workspace.id, "source", "setup-issuer");
    expect(result.lease.state).toBe("delivered");
    expect(result.lease.credentialBytes).toBe(Buffer.byteLength(result.credential));
    expect(result.lease.issuerExpiresAt).toEqual(f.workspace.deadlineAt);
    expect(await f.issuer.resource(result.credential, f.workspace.id)).toBe(200);
    expect(await f.issuer.resource(result.credential, randomUUID())).toBe(401);
    expect(await f.issuer.resource(result.credential, f.workspace.id, "another-source")).toBe(401);
    const stored = JSON.stringify(await f.store.getWorkspaceLease(result.lease.id));
    expect(stored).not.toContain(result.credential);
    expect(stored).not.toContain(f.issuer.authorization);
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(result.credential, f.workspace.id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("fenced");
  } finally {
    await f.close();
  }
});

test("a lost mint response remains pending and exact request-ID revocation closes its actual issuer authority", async () => {
  const f = await fixture();
  try {
    f.issuer.controls.reply = "lost";
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("unavailable");
    const [row] = await f.store.listPendingWorkspaceLeases(f.workspace.id);
    if (!row) throw new Error("Missing test lease");
    expect(row).toMatchObject({ state: "requested", issuerLeaseId: null });
    expect(await f.issuer.resource(f.issuer.controls.captured, f.workspace.id)).toBe(200);
    f.issuer.controls.reply = "outage";
    await expect(f.service.revokeWorkspace(f.workspace.id)).rejects.toThrow("unavailable");
    expect(await f.store.getWorkspaceLease(row.id)).toMatchObject({ state: "revoking" });
    f.issuer.controls.reply = "valid";
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(f.issuer.controls.captured, f.workspace.id)).toBe(401);
    expect(await f.store.getWorkspaceLease(row.id)).toMatchObject({ state: "revoked" });
  } finally {
    await f.close();
  }
});

test.each(["wrong-workspace", "long-expiry", "redirect"] as const)(
  "issuer %s replies never reach a workspace",
  async (reply) => {
    const f = await fixture();
    try {
      f.issuer.controls.reply = reply;
      await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("unavailable");
      const [row] = await f.store.listPendingWorkspaceLeases(f.workspace.id);
      expect(row).toMatchObject({ state: "requested", issuerLeaseId: null, deliveredAt: null });
      expect(f.issuer.controls.redirectCalls).toBe(0);
      f.issuer.controls.reply = "valid";
      await f.service.revokeWorkspace(f.workspace.id);
      expect(await f.issuer.resource(f.issuer.controls.captured, f.workspace.id)).toBe(401);
    } finally {
      await f.close();
    }
  },
);

test("retained issuer configuration revokes after rotation and retirement", async () => {
  const f = await fixture();
  try {
    const result = await f.service.issue(f.workspace.id, "source", "setup-issuer");
    await f.vault.put(f.key.id, "source", {
      ...f.config,
      value: { ...f.config.value, authorization: "unusable-replacement" },
    });
    await f.vault.retire(f.key.id, "source");
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(result.credential, f.workspace.id)).toBe(401);
    expect(f.issuer.controls.revokeCalls).toBe(1);
  } finally {
    await f.close();
  }
});

test("a teardown fence during HTTPS mint prevents delivery and revokes the late response", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    f.issuer.controls.beforeMint = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.service.issue(f.workspace.id, "source", "setup-issuer").catch((error) => error);
    await entered.promise;
    await f.store.fenceWorkspaceLeases(f.workspace.id, new Date());
    release.resolve();
    expect(await pending).toMatchObject({ message: "Workspace issuer is unavailable." });
    expect(await f.issuer.resource(f.issuer.controls.captured, f.workspace.id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("request retry keeps one issuer credential and cannot extend its stored expiry", async () => {
  const f = await fixture();
  try {
    const requestId = randomUUID();
    const first = await f.service.issue(f.workspace.id, "source", "setup-issuer", requestId);
    const second = await f.service.issue(f.workspace.id, "source", "setup-issuer", requestId);
    expect(second.lease.id).toBe(first.lease.id);
    expect(second.credential).toBe(first.credential);
    expect(second.lease.issuerExpiresAt).toEqual(first.lease.issuerExpiresAt);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toHaveLength(1);
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(first.credential, f.workspace.id)).toBe(401);
  } finally {
    await f.close();
  }
});

test("setup completion tombstones a mint already in flight before connection", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    f.issuer.controls.beforeMint = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.service.issue(f.workspace.id, "source", "setup-issuer").catch((error) => error);
    await entered.promise;
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
    await f.service.completeSetup(f.workspace.id);
    release.resolve();
    expect(await pending).toMatchObject({ message: "Workspace issuer is unavailable." });
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
    expect(await f.store.listWorkspaceLeases(f.workspace.id)).toMatchObject([{ state: "revoked" }]);
    expect(await f.issuer.resource(f.issuer.controls.captured, f.workspace.id)).toBe(401);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("the HTTPS client refuses an issuer certificate outside its trust roots", async () => {
  const f = await fixture();
  try {
    const untrusted = createWorkspaceLeaseService({
      store: f.store,
      vault: f.vault,
      issuer: createIssuerClient(),
    });
    await expect(untrusted.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("unavailable");
    expect(f.issuer.controls.mintCalls).toBe(0);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toHaveLength(1);
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("disk reopen reconciles a lost mint response against its actual retained issuer", async () => {
  const f = await fixture("disk");
  try {
    f.issuer.controls.reply = "lost";
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("unavailable");
    const captured = f.issuer.controls.captured;
    expect(await f.issuer.resource(captured, f.workspace.id)).toBe(200);
    const directory = f.context.dataDir;
    if (!directory) throw new Error("Missing test data directory");
    await f.store.close();
    f.issuer.controls.reply = "valid";
    const store = await PGliteStore.create(directory);
    try {
      const service = createWorkspaceLeaseService({
        store,
        vault: createSecretVault(store, f.encryptionKey),
        issuer: createIssuerClient({ ca: f.issuer.ca }),
      });
      expect(await store.listPendingWorkspaceLeases(f.workspace.id)).toHaveLength(1);
      await service.revokeWorkspace(f.workspace.id);
      expect(await store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
      expect(await f.issuer.resource(captured, f.workspace.id)).toBe(401);
    } finally {
      await store.close();
    }
  } finally {
    await f.close();
  }
});

test("HTTP error rejection cancels the real issuer response without waiting for its transport deadline", async () => {
  const f = await fixture();
  try {
    f.issuer.controls.reply = "outage-stream";
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("unavailable");
    expect(
      await Promise.race([f.issuer.controls.errorCancelled.promise.then(() => true), Bun.sleep(250).then(() => false)]),
    ).toBe(true);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each(["mint", "revoke"] as const)(
  "deep JSON in an HTTPS %s reply yields only the generic issuer error",
  async (operation) => {
    const f = await fixture();
    try {
      const issued =
        operation === "revoke" ? await f.service.issue(f.workspace.id, "source", "setup-issuer") : undefined;
      f.issuer.controls.reply = "deep-policy";
      const pending = issued
        ? f.service.revoke(issued.lease.id)
        : f.service.issue(f.workspace.id, "source", "setup-issuer");
      await expect(pending).rejects.toMatchObject({
        code: "secret.unavailable",
        message: "Workspace issuer is unavailable.",
      });
      expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);
