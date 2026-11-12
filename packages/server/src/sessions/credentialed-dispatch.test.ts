import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fakeProducer, managedFixture } from "./managed-fixture.test";

test("a credentialed session's request waits until its credentials make the session ready", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const principalId = m.f.principal.id;
    await m.f.store.updatePrincipal(principalId, ["admin", "secrets:write"], ["*"]);
    const profileId = randomUUID();
    await m.f.store.managed.profiles.reconcile(
      principalId,
      {
        [profileId]: {
          template: m.f.runtime.template.name,
          templateVersion: m.f.runtime.template.version,
          issuer: "issuer",
          placement: "shared",
          limits: { workspacesPerOwner: 5, sessionsPerWorkspace: 8 },
          dispatchDeadlineSeconds: 600,
        },
      },
      { issuer: { url: "https://issuer.example/mint", tokenFile: "/controller/issuer", policy: {}, revoke: false } },
    );
    const sessionId = randomUUID();
    const identity = { principalId, sessionId };
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profile: profileId, owner: "test-owner" });
    await m.f.store.managed.sessions.bind(identity, 0, {
      workspaceId: m.f.id,
      incarnationId: m.f.runtime.incarnationId,
      generation: 1,
    });
    const requestId = await m.submit(sessionId, "run when ready");
    await m.settle();
    expect((await m.request(sessionId, requestId)).state).not.toBe("running");
    expect(producer.sent("run when ready")).toEqual([]);

    const current = await m.f.store.managed.sessions.get(m.keyId, sessionId);
    await m.f.store.managed.sessions.appendObservation(identity, current.revision, "ready", null);
    await m.settle();
    expect((await m.request(sessionId, requestId)).state).toBe("running");
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
