import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { managedFixture, provision } from "../managed/fixture.test";

async function session(f: Awaited<ReturnType<typeof managedFixture>>, group = "test-owner", owner = "test-owner") {
  const sessionId = randomUUID();
  await f.store.managed.sessions.create(f.keyId, { sessionId, profile: f.profile.name, owner, group });
  return { principalId: f.principal.id, sessionId };
}

test("five concurrent first placements reserve one workspace and wait for its capabilities", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const ids = await Promise.all(Array.from({ length: 5 }, () => session(f)));
    const intents = await Promise.all(ids.map((id) => f.store.managed.capacity.reserve(id, 1, new Date())));
    expect(intents.filter(Boolean)).toHaveLength(1);
    const rows = await f.context.db.select().from(f.context.tables.managedCapacity);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.record).toMatchObject({ owner: "test-owner", profile: f.profile.name, state: "reserved" });
    const intent = intents.find(Boolean)!;
    expect(intent.templateDigest).toBe(f.template.digest);
    // A restart reads the recorded reservation, rather than spending another slot.
    const original = ids[intents.findIndex(Boolean)]!;
    expect(await f.store.managed.capacity.reserve(original, 1, new Date())).toEqual(intent);
  } finally {
    await f.dispose();
  }
});

test("owner limits span groups, while a different owner has its own capacity", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const ids = await Promise.all(Array.from({ length: 5 }, (_, i) => session(f, `group-${i}`)));
    const intents = await Promise.all(ids.map((id) => f.store.managed.capacity.reserve(id, 1, new Date())));
    expect(intents.filter(Boolean)).toHaveLength(2);
    const other = await session(f, "group-0", "other-owner");
    expect(await f.store.managed.capacity.reserve(other, 1, new Date())).not.toBeNull();
  } finally {
    await f.dispose();
  }
});

test("close fences a reserved placement before creation and releases its owner capacity", async () => {
  const f = await managedFixture();
  try {
    f.profile.limits.workspacesPerOwner = 1;
    await provision(f);
    const identity = { principalId: f.principal.id, sessionId: f.sessionId };
    expect(await f.store.managed.capacity.reserve(identity, 1, new Date())).not.toBeNull();
    expect((await f.store.managed.sessions.close(f.keyId, f.sessionId, new Date())).receipt.state).toBe("completed");
    const next = await session(f);
    expect(await f.store.managed.capacity.reserve(next, 1, new Date())).not.toBeNull();
    expect(await f.store.managed.capacity.reserve(identity, 1, new Date())).toBeNull();
    // The reservation remains historical, but the insert owner refuses its closed session.
  } finally {
    await f.dispose();
  }
});

test("closing a reused session UUID cannot release another principal's reservation", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const other = await f.store.createPrincipal("other-reservation-owner", ["admin"], ["*"]);
    const key = randomUUID();
    await f.store.insertMachineKey({
      id: key,
      principalId: other.id,
      secretDigest: new Uint8Array([1]),
      scopes: [],
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    const { name, templateDigest: _digest, ...config } = f.profile;
    await f.store.managed.profiles.reconcile(other.id, { [name]: config }, {});
    await f.store.managed.sessions.create(key, { sessionId: f.sessionId, profile: name, owner: "test-owner" });
    const identity = { principalId: other.id, sessionId: f.sessionId };
    const intent = await f.store.managed.capacity.reserve(identity, 1, new Date());
    await f.store.managed.sessions.close(f.keyId, f.sessionId, new Date());
    const [row] = await f.context.db.select().from(f.context.tables.managedCapacity);
    expect(row?.record.state).toBe("reserved");
    expect(row?.record.sessions[0]?.stoppedAt).toBeNull();
    expect(await f.store.managed.capacity.reserve(identity, 1, new Date())).toEqual(intent);
  } finally {
    await f.dispose();
  }
});

test("canceling an uncreated placement fences a late workspace insert", async () => {
  const f = await managedFixture();
  try {
    await provision(f);
    const id = { principalId: f.principal.id, sessionId: f.sessionId };
    const intent = await f.store.managed.capacity.reserve(id, 1, new Date());
    if (!intent) throw new Error("Missing placement");
    expect(await f.store.managed.capacity.cancelPlacement(id, intent.workspaceId, new Date())).toBe(true);
    await expect(
      f.store.insertWorkspace({
        id: intent.workspaceId,
        principalId: f.principal.id,
        externalId: "stale-placement",
        idempotencyKey: "stale-placement",
        requestDigest: "stale-placement",
        templateId: f.template.id,
        templateSnapshot: {
          name: f.template.name,
          version: f.template.version,
          digest: f.template.digest,
          spec: f.parsed.manifest.spec,
        },
        launchInput: null,
        metadata: { "pocketcoder.managed-session": f.sessionId },
        deadlineAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "revision.stale" });
    expect(await f.store.getWorkspace(intent.workspaceId)).toBeNull();
    const rows = await f.context.db.select().from(f.context.tables.managedCapacity);
    expect(rows[0]?.record).toMatchObject({ state: "released", cleanup: { basis: "never_launched" } });
  } finally {
    await f.dispose();
  }
});
