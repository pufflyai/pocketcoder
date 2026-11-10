import { expect, test } from "bun:test";
import { leaseServiceFixture } from "./lease-service-fixture";

// The managed Pi template receives its model gateway bearer through a fixed-scope slot. The slot's
// policyRef names the issuer secret, so delivery uses the same expiring per-workspace lease.
async function piTemplate(policyRef: string) {
  const raw = await Bun.file(new URL("../../../../examples/templates/pi-managed.json", import.meta.url)).json();
  raw.spec.credentialSlots["model-gateway"].policyRef = policyRef;
  return raw;
}

test("a workload credential slot receives an expiring, workspace-bound issuer lease", async () => {
  const f = await leaseServiceFixture("memory", undefined, undefined, false, await piTemplate("runtime"));
  try {
    await f.vault.put(f.key.id, "runtime", { ...f.config, type: "runtime-issuer" });
    await f.vault.put(f.key.id, "undeclared", { ...f.config, type: "runtime-issuer" });
    await f.store.transition(f.workspace.id, { from: ["provisioning"], to: "connected", at: new Date() });
    const issued = await f.service.issue(f.workspace.id, "runtime", "runtime-issuer");
    expect(issued.lease.requestExpiresAt.getTime()).toBeLessThanOrEqual(f.workspace.deadlineAt.getTime());
    expect(await f.issuer.resource(issued.credential, f.workspace.id)).toBe(200);
    // Only secrets named by the template's slots can be issued to this workspace.
    await expect(f.service.issue(f.workspace.id, "undeclared", "runtime-issuer")).rejects.toThrow();
    await f.service.revokeWorkspace(f.workspace.id);
    expect(await f.issuer.resource(issued.credential, f.workspace.id)).toBe(401);
  } finally {
    await f.close();
  }
});
