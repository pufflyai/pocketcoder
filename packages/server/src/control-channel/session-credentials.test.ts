import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managed, type ServerFrame } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { WSContext } from "hono/ws";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { credentialedProfile } from "../secrets/managed-lease-fixture";
import { renewCredential } from "./credential-frames";
import { Hub } from "./hub";
import { sessionCredentials } from "./session-credentials";
import { workspaceCredentialsFor } from "./workspace-credentials";
import type { WsDeps } from "./ws-types";

async function sharedWorkspace(protocolVersion: 14 | 15 = 15) {
  const f = await leaseServiceFixture("memory", undefined, undefined, true);
  const profile = await credentialedProfile(f, { credentialPlacement: "shared" });
  const { db, tables } = f.context;
  await db
    .update(tables.workspaces)
    .set({ state: "ready", connectionEpoch: 1, metadata: { [managed.MANAGED_SESSION_METADATA]: randomUUID() } })
    .where(eq(tables.workspaces.id, f.workspace.id));
  const frames: ServerFrame[] = [];
  const hub = new Hub();
  const socket = { send: (text: string) => frames.push(JSON.parse(text)), close() {} } as unknown as WSContext;
  const connection = hub.attach(f.workspace.id, randomUUID(), 1, socket, protocolVersion);
  connection.registered = true;
  const deps = { store: f.store, hub, workspaceLeases: f.service } as unknown as WsDeps;
  const owner = sessionCredentials(deps);
  async function bound() {
    const identity = await profile.session();
    await f.store.managed.sessions.bind(identity, 0, {
      workspaceId: f.workspace.id,
      incarnationId: profile.incarnationId,
      generation: 1,
    });
    return identity;
  }
  const installed = () => frames.filter((frame) => frame.type === "credential_install");
  return { f, frames, connection, deps, owner, bound, installed };
}

test("each bound session receives, renews and loses its own leases in its own folder", async () => {
  const w = await sharedWorkspace();
  try {
    const [first, second] = [await w.bound(), await w.bound()];
    await w.owner.deliver(first, w.f.workspace.id, 1);
    await w.owner.deliver(first, w.f.workspace.id, 1);
    await w.owner.deliver(second, w.f.workspace.id, 1);
    const [own, sibling] = w.installed().map((frame) => frame.payload.credentials[0]);
    expect(w.installed()).toHaveLength(2);
    if (!own || !sibling) throw new Error("Missing session credentials");
    expect(own).toMatchObject({
      session_id: first.sessionId,
      path: `/run/pocketcoder/secrets/leases/sessions/${first.sessionId}/runtime`,
    });
    expect(sibling?.session_id).toBe(second.sessionId);

    // A reconnecting workspace gets every bound session's lease back, and no workspace lease.
    const row = await w.f.store.getWorkspace(w.f.workspace.id);
    if (!row) throw new Error("Missing workspace");
    const replayed = await workspaceCredentialsFor(w.deps, row);
    expect(replayed.map((credential) => credential.session_id).sort()).toEqual(
      [first.sessionId, second.sessionId].sort(),
    );

    await renewCredential(w.deps, w.connection, { lease_id: sibling.lease_id, request_id: randomUUID() });
    expect(w.frames.at(-1)).toMatchObject({
      type: "credential_renewed",
      payload: { credential: { session_id: second.sessionId } },
    });

    await w.owner.revoke(w.f.workspace.id, first.sessionId);
    expect(w.frames.at(-1)).toMatchObject({ type: "credential_remove", payload: { session_id: first.sessionId } });
    expect(await w.f.issuer.resource(own.credential, w.f.workspace.id)).toBe(401);
    expect(await w.f.issuer.resource(sibling.credential, w.f.workspace.id)).toBe(200);
  } finally {
    await w.f.close();
  }
});

test("a supervisor too old for session leases never receives them", async () => {
  const w = await sharedWorkspace(14);
  try {
    await expect(w.owner.deliver(await w.bound(), w.f.workspace.id, 1)).rejects.toThrow("unavailable");
    expect(w.installed()).toEqual([]);
  } finally {
    await w.f.close();
  }
});
