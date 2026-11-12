import { expect, test } from "bun:test";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { sourceCredentialFor } from "./ws-auth";

test("repeated setup registrations mint fresh and never replay superseded or revoking leases", async () => {
  const f = await leaseServiceFixture();
  try {
    const deps = { store: f.store, workspaceLeases: f.service };
    const first = await sourceCredentialFor(deps, f.workspace);
    const second = await sourceCredentialFor(deps, f.workspace);
    const third = await sourceCredentialFor(deps, f.workspace);
    if (!first || !second || !third) throw new Error("Missing setup credential");
    expect(new Set([first.lease.requestId, second.lease.requestId, third.lease.requestId]).size).toBe(3);
    await f.store.requestWorkspaceLeaseRevocation(third.lease.id, new Date());
    const fourth = await sourceCredentialFor(deps, f.workspace);
    expect(fourth?.lease.id).not.toBe(third.lease.id);
    expect(fourth?.lease.state).toBe("delivered");
    expect(f.issuer.controls.mintCalls).toBe(4);
  } finally {
    await f.close();
  }
});
