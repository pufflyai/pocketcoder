import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { leaseServiceFixture } from "./lease-service-fixture";

test("a running workspace renews with fresh HTTPS credentials and lets the previous credential expire", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
    const initial = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
    expect(initial.lease.requestExpiresAt.getTime()).toBeLessThanOrEqual(f.workspace.deadlineAt.getTime());
    expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(200);
    expect(await f.issuer.resource(initial.credential, randomUUID())).toBe(401);
    expect(await f.issuer.resource(initial.credential, f.workspace.id, "other")).toBe(401);
    const requestId = randomUUID();
    f.issuer.controls.reply = "lost";
    await expect(f.service.renew(f.workspace.id, initial.lease.id, requestId)).rejects.toThrow();
    const pending = (await f.store.listPendingWorkspaceLeases(f.workspace.id)).find(
      (row) => row.id !== initial.lease.id,
    );
    if (!pending) throw new Error("Missing renewal request");
    expect(pending.state).toBe("superseded");
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    f.issuer.controls.reply = "valid";
    const renewed = await f.service.renew(f.workspace.id, initial.lease.id, requestId);
    expect(renewed.lease.id).not.toBe(pending.id);
    expect(renewed.lease.secretVersionId).not.toBe(pending.secretVersionId);
    expect(renewed.lease.requestDigest).not.toBe(pending.requestDigest);
    expect(await f.issuer.resource(renewed.credential, f.workspace.id)).toBe(200);
    await f.service.completeRenewal(f.workspace.id, initial.lease.id, renewed.lease.id);
    expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(200);
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(renewed.credential, f.workspace.id)).toBe(401);
    await expect(f.service.renew(f.workspace.id, renewed.lease.id, randomUUID())).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test.each(["setup-issuer", "registry"] as const)("runtime authority cannot resolve a %s secret", async (type) => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    const value =
      type === "setup-issuer"
        ? { ...f.config, type }
        : { type, value: { server: "registry.example", username: "workspace-fixture", password: randomUUID() } };
    await f.vault.put(f.key.id, "runtime", value);
    await expect(f.service.issue(f.workspace.id, "runtime", "runtime-issuer")).rejects.toThrow();
    expect(f.issuer.controls.mintCalls).toBe(0);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(["preserving", "terminating"] as const)(
  "%s stops runtime issuance and waits for acknowledged cleanup",
  async (state) => {
    const f = await leaseServiceFixture("memory", undefined, undefined, true);
    try {
      await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
      const initial = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
      await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
      await f.store.transition(f.workspace.id, { from: ["connected"], to: state, at: new Date() });
      await expect(f.service.renew(f.workspace.id, initial.lease.id, randomUUID())).rejects.toThrow();
      f.issuer.controls.reply = "outage";
      await expect(f.service.revokeWorkspace(f.workspace.id)).rejects.toThrow();
      expect((await f.store.getWorkspaceLease(initial.lease.id))?.state).toBe("revoking");
      expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(200);
      f.issuer.controls.reply = "valid";
      await f.service.revokeWorkspace(f.workspace.id);
      expect(await f.issuer.resource(initial.credential, f.workspace.id)).toBe(401);
    } finally {
      await f.close();
    }
  },
);

test("an uncertain runtime mint is revoked by its recorded request identity", async () => {
  const f = await leaseServiceFixture("disk", undefined, undefined, true);
  try {
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    const requestId = randomUUID();
    f.issuer.controls.reply = "lost";
    await expect(f.service.issue(f.workspace.id, "runtime", "runtime-issuer", requestId)).rejects.toThrow();
    const captured = f.issuer.controls.captured;
    const [request] = await f.store.listPendingWorkspaceLeases(f.workspace.id);
    expect(request?.requestId).not.toBe(requestId);
    f.issuer.controls.reply = "outage";
    await expect(f.service.revokeWorkspace(f.workspace.id)).rejects.toThrow();
    expect((await f.store.listPendingWorkspaceLeases(f.workspace.id))[0]?.requestId).toBe(request?.requestId);
    expect(await f.issuer.resource(captured, f.workspace.id)).toBe(200);
    f.issuer.controls.reply = "valid";
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(captured, f.workspace.id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases(f.workspace.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("setup completion cannot revoke later runtime credentials in the same workspace", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  try {
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    const setup = await f.service.issue(f.workspace.id, "source", "setup-issuer");
    await f.service.completeSetup(f.workspace.id);
    expect(await f.issuer.resource(setup.credential, f.workspace.id)).toBe(401);
    const runtime = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
    expect(await f.issuer.resource(runtime.credential, f.workspace.id)).toBe(200);
    f.issuer.controls.leaseLifetimeMs = 100;
    const earlier = await f.service.renew(f.workspace.id, runtime.lease.id, randomUUID());
    await f.service.completeRenewal(f.workspace.id, runtime.lease.id, earlier.lease.id);
    f.issuer.controls.leaseLifetimeMs = 30000;
    const newest = await f.service.renew(f.workspace.id, earlier.lease.id, randomUUID());
    await f.service.completeRenewal(f.workspace.id, earlier.lease.id, newest.lease.id);
    await Bun.sleep(120);
    await f.service.expire(earlier.lease.id);
    expect(await f.issuer.resource(newest.credential, f.workspace.id)).toBe(200);
    expect(f.issuer.controls.revokeCalls).toBe(1);
  } finally {
    await f.close();
  }
});
