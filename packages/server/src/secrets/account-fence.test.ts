import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createIssuerClient } from "./issuer-client";
import { createWorkspaceLeaseService } from "./lease-service";
import { leaseServiceFixture } from "./lease-service-fixture";

test("the account fence closes authority minted by an already accepted HTTPS request", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  let release!: () => void;
  try {
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
    let fenced = false;
    const service = createWorkspaceLeaseService({
      store: f.store,
      vault: f.vault,
      issuer: createIssuerClient({ ca: f.issuer.ca }),
      admissionFenced: () => fenced,
    });
    let entered!: () => void;
    const accepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.issuer.controls.beforeMint = async () => {
      entered();
      await held;
    };
    const mint = service.issue(f.workspace.id, "runtime", "runtime-issuer");
    await accepted;
    fenced = true;
    release();
    await expect(mint).rejects.toThrow("unavailable");
    const [receipt] = await f.store.listWorkspaceLeases(f.workspace.id);
    expect(receipt?.deliveredAt).toBeNull();
    await service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(f.issuer.controls.captured, f.workspace.id)).toBe(401);
    expect(await f.store.listPendingWorkspaceLeases()).toEqual([]);
    expect(f.issuer.controls.mintCalls).toBe(1);
    await expect(service.issue(f.workspace.id, "runtime", "runtime-issuer", randomUUID())).rejects.toThrow(
      "unavailable",
    );
    expect(f.issuer.controls.mintCalls).toBe(1);
    const [lease] = await f.store.listWorkspaceLeases(f.workspace.id);
    if (!lease) throw new Error("Lease receipt missing");
    await expect(service.renew(f.workspace.id, lease.id, randomUUID())).rejects.toThrow("unavailable");
    await service.revokeWorkspace(f.workspace.id);
    expect(f.issuer.controls.mintCalls).toBe(1);
  } finally {
    release?.();
    await f.close();
  }
});
