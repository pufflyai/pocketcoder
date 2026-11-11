import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createSecretVault } from "../secrets/secret-vault";
import { fakeProducer, managedFixture } from "./managed-fixture.test";

test("a credentialed session's request waits until its credentials make the session ready", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  try {
    const principalId = m.f.principal.id;
    await m.f.store.updatePrincipal(principalId, ["admin", "secrets:write"], ["*"]);
    const writer = randomUUID();
    await m.f.store.insertMachineKey({
      id: writer,
      principalId,
      secretDigest: new Uint8Array([8]),
      scopes: ["secrets:write"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
      revokedAt: null,
      lastUsedAt: null,
    });
    await createSecretVault(m.f.store, randomBytes(32)).put(writer, "issuer", {
      type: "runtime-issuer",
      value: { url: "https://issuer.example/mint", authorization: "Bearer test", policy: {} },
    });
    const bindingId = randomUUID();
    await m.f.store.managed.authority.registerCredential(m.keyId, {
      bindingId,
      principalId,
      secretName: "issuer",
      slots: ["runtime"],
      authorityExpiresAt: new Date(Date.now() + 600_000),
    });
    const profileId = randomUUID();
    await m.f.store.managed.authority.provisionProfile(m.keyId, principalId, {
      profileId,
      revision: 1,
      isolationScopeId: randomUUID(),
      budgetScopeIds: [m.scopeId],
      templateDigest: m.f.runtime.template.digest,
      credentialBindingId: bindingId,
    });
    const sessionId = randomUUID();
    const identity = { principalId, sessionId };
    await m.f.store.managed.sessions.create(m.keyId, { sessionId, profileId, profileRevision: 1 });
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
