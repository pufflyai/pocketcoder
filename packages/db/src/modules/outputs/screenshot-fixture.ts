import { randomUUID } from "node:crypto";
import { createPGliteFixture, insertTestWorkspace } from "../../test-fixtures";

export async function screenshotFixture(mode: "memory" | "disk" = "memory") {
  const f = await createPGliteFixture("pc-screenshot", mode);
  const workspace = await insertTestWorkspace(f, "screen");
  const at = new Date();
  for (const [from, to] of [
    ["queued", "provisioning"],
    ["provisioning", "connected"],
    ["connected", "ready"],
  ] as const)
    await f.store.transition(workspace.id, { from: [from], to, at });
  const keyId = randomUUID();
  await f.store.insertMachineKey({
    id: keyId,
    principalId: f.principal.id,
    secretDigest: new Uint8Array(32),
    scopes: ["admin"],
    createdAt: at,
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
    lastUsedAt: null,
  });
  const input = {
    id: randomUUID(),
    workspaceId: workspace.id,
    principalId: f.principal.id,
    keyId,
    connectionEpoch: 0,
    grantDigest: new Uint8Array(32),
    expiresAt: new Date(Date.now() + 10_000),
    retainedUntil: new Date(Date.now() + 60_000),
    reservationId: randomUUID(),
    reservedBytes: 8192,
  };
  const capacity = async () => ({
    workspace: { bytes: 8192, files: 1 },
    principal: { bytes: 8192, files: 1 },
    instance: { bytes: 8192, files: 1 },
    freeDisk: { bytes: 8192, files: 1, headroomBytes: 0, headroomFiles: 0 },
  });
  return { ...f, workspace, input, capacity };
}
