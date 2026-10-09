import { expect, test } from "bun:test";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { FakeDriver } from "@pstdio/pocketcoder-testkit";
import { buildServer } from "../app";
import { createIssuerClient } from "../secrets/issuer-client";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { reconcileSetupLeases } from "./setup-lease-reconciliation";

test("restart and issuer outage keep uncertain source cleanup pending until acknowledged", async () => {
  const f = await leaseServiceFixture();
  const built = buildServer({
    store: f.store,
    driver: new FakeDriver(),
    pepper: f.pepper,
    secretKey: f.encryptionKey.toString("base64url"),
    issuerClient: createIssuerClient({ ca: f.issuer.ca }),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:1",
  });
  try {
    f.issuer.controls.reply = "lost";
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("unavailable");
    const captured = f.issuer.controls.captured;
    expect(await f.issuer.resource(captured, f.workspace.id)).toBe(200);
    f.issuer.controls.reply = "outage";
    expect(await reconcileSetupLeases(f.store, built.workspaceLeases, built.scheduler, true)).toBe(1);
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("terminating");
    expect((await f.store.listPendingWorkspaceLeases(f.workspace.id))[0]?.state).toBe("revoking");
    expect(await f.issuer.resource(captured, f.workspace.id)).toBe(200);
    f.issuer.controls.reply = "valid";
    expect(await reconcileSetupLeases(f.store, built.workspaceLeases, built.scheduler)).toBe(0);
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("failed");
    expect(await f.issuer.resource(captured, f.workspace.id)).toBe(401);
  } finally {
    await built.scheduler.drain();
    await f.close();
  }
});

test("ready and terminal transitions require delivered and closed source authority", async () => {
  const f = await leaseServiceFixture();
  const at = new Date();
  try {
    const issued = await f.service.issue(f.workspace.id, "source", "setup-issuer");
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at });
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("inactive");
    expect(await f.store.transition(f.workspace.id, { from: ["connected"], to: "ready", at })).toBeNull();
    await f.service.completeSetup(f.workspace.id);
    expect(await f.store.transition(f.workspace.id, { from: ["connected"], to: "ready", at })).toMatchObject({
      state: "ready",
    });
    expect(await f.issuer.resource(issued.credential, f.workspace.id)).toBe(401);
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("inactive");
    expect(await f.store.transition(f.workspace.id, { from: ["ready"], to: "failed", at })).toMatchObject({
      state: "failed",
    });
  } finally {
    await f.close();
  }
});

test("ready requires delivered source authority", async () => {
  const f = await leaseServiceFixture();
  const at = new Date();
  try {
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at });
    expect(await f.store.transition(f.workspace.id, { from: ["connected"], to: "ready", at })).toBeNull();
  } finally {
    await f.close();
  }
});

test("terminal transitions fence pending source authority", async () => {
  const f = await leaseServiceFixture();
  const at = new Date();
  try {
    const later = await f.service.issue(f.workspace.id, "source", "setup-issuer");
    expect(await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "failed", at })).toBeNull();
    expect((await f.store.getWorkspaceLease(later.lease.id))?.state).toBe("revoking");
    await expect(f.service.issue(f.workspace.id, "source", "setup-issuer")).rejects.toThrow("fenced");
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "failed", at })).toMatchObject({
      state: "failed",
    });
  } finally {
    await f.close();
  }
});

test.each([false, true])("lease reconciliation leaves the preserving runtime owned (startup=%s)", async (startup) => {
  const f = await leaseServiceFixture();
  const driver = new FakeDriver();
  const built = buildServer({
    store: f.store,
    driver,
    pepper: f.pepper,
    secretKey: f.encryptionKey.toString("base64url"),
    issuerClient: createIssuerClient({ ca: f.issuer.ca }),
    limits: DEFAULT_LIMITS,
    workspaceServerUrl: "http://127.0.0.1:1",
  });
  try {
    const issued = await f.service.issue(f.workspace.id, "source", "setup-issuer");
    const at = new Date();
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at });
    await f.store.updateWorkspace(
      f.workspace.id,
      { providerKind: "fake", providerRef: { kind: "fake", id: "preserving-provider" } },
      at,
    );
    await f.store.transition(f.workspace.id, { from: ["connected"], to: "preserving", at });
    expect(await reconcileSetupLeases(f.store, built.workspaceLeases, built.scheduler, startup)).toBe(0);
    expect(driver.stopped).toEqual([]);
    expect(driver.terminated).toEqual([]);
    expect((await f.store.getWorkspace(f.workspace.id))?.state).toBe("preserving");
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
    expect(await f.issuer.resource(issued.credential, f.workspace.id)).toBe(401);
  } finally {
    await built.scheduler.drain();
    await f.close();
  }
});
