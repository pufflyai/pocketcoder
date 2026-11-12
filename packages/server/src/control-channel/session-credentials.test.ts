import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managed, type ServerFrame } from "@pstdio/pocketcoder-contracts";
import { eq } from "drizzle-orm";
import type { WSContext } from "hono/ws";
import { leaseServiceFixture } from "../secrets/lease-service-fixture";
import { credentialedProfile } from "../secrets/managed-lease-fixture";
import { acknowledgeInstall, renewCredential } from "./credential-frames";
import { Hub } from "./hub";
import { SESSION_CREDENTIAL_LIMITS, sessionCredentials } from "./session-credentials";
import { workspaceCredentialsFor } from "./workspace-credentials";
import type { WsDeps } from "./ws-types";

async function sharedWorkspace(protocolVersion: 14 | 15 = 15, limits = SESSION_CREDENTIAL_LIMITS) {
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
  const owner = sessionCredentials(deps, limits);
  async function bound() {
    const identity = await profile.session();
    await f.store.managed.sessions.bind(identity, 0, {
      workspaceId: f.workspace.id,
      incarnationId: profile.incarnationId,
      generation: 1,
    });
    return identity;
  }
  const installed = () =>
    frames.flatMap((frame) => (frame.type === "credential_install" ? [frame.payload.credentials] : []));
  // The supervisor confirms every lease of the latest install, as `credential_install_ack` does.
  const confirm = () =>
    acknowledgeInstall(connection, { lease_ids: (installed().at(-1) ?? []).map((value) => value.lease_id) });
  return { f, frames, connection, deps, owner, bound, installed, confirm };
}

test("each bound session receives, renews and loses its own leases in its own folder", async () => {
  const w = await sharedWorkspace();
  try {
    const [first, second] = [await w.bound(), await w.bound()];
    // Unconfirmed leases are sent again unchanged; a confirmed session needs nothing more.
    expect(await w.owner.deliver(first, w.f.workspace.id, 1)).toBe(false);
    expect(await w.owner.deliver(first, w.f.workspace.id, 1)).toBe(false);
    expect(w.installed()[1]).toEqual(w.installed()[0]);
    w.confirm();
    expect(await w.owner.deliver(first, w.f.workspace.id, 1)).toBe(true);
    expect(await w.owner.deliver(second, w.f.workspace.id, 1)).toBe(false);
    w.confirm();
    expect(w.installed()).toHaveLength(3);
    const [own, , sibling] = w.installed().map((credentials) => credentials[0]);
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

test("a session whose lease requests never completed gets them replayed, not refused at the limit", async () => {
  const w = await sharedWorkspace();
  try {
    const identity = await w.bound();
    w.f.issuer.controls.reply = "lost";
    for (let i = 0; i < 2; i++)
      await expect(w.owner.deliver(identity, w.f.workspace.id, 1)).rejects.toThrow("unavailable");
    w.f.issuer.controls.reply = "valid";
    await w.owner.deliver(identity, w.f.workspace.id, 1);
    expect(w.installed().map((credentials) => credentials[0]?.session_id)).toEqual([identity.sessionId]);
  } finally {
    await w.f.close();
  }
});

test.each([
  { name: "too many credentials", limits: { count: 1, bytes: SESSION_CREDENTIAL_LIMITS.bytes }, admitted: 1 },
  { name: "too many bytes", limits: { count: SESSION_CREDENTIAL_LIMITS.count, bytes: 1 }, admitted: 0 },
])(
  "a session whose credentials would exceed one reconnect's replay ($name) is refused and leaves nothing pending",
  async ({ limits, admitted }) => {
    const w = await sharedWorkspace(15, limits);
    try {
      const sessions = [await w.bound(), await w.bound()];
      const results = [];
      for (const identity of sessions)
        results.push(
          await w.owner.deliver(identity, w.f.workspace.id, 1).then(
            () => "sent",
            () => "refused",
          ),
        );
      expect(results.filter((result) => result === "sent")).toHaveLength(admitted);
      const pending = await w.f.store.listPendingWorkspaceLeases(w.f.workspace.id);
      const holders = new Set(pending.map((lease) => lease.managedAuthority?.sessionId));
      expect(holders.size).toBe(admitted);
      expect(w.installed()).toHaveLength(admitted);
    } finally {
      await w.f.close();
    }
  },
);
