import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PocketCoderError } from "@pstdio/pocketcoder-sdk";
import { fakeProducer, managedFixture } from "./managed-fixture.test";
import { sdkClient } from "./sdk-fixture.test";

const deadline = () => new Date(Date.now() + 60_000).toISOString();

test("the SDK runs a session lifecycle with lost replies, scoped cancel, delayed collect and history reconnect", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const { client } = await sdkClient(m);
  try {
    const sessionId = await m.session();
    const sibling = await m.session();
    expect((await client.sessions.get(sessionId)).sessionId).toBe(sessionId);

    // A lost reply is retried with the exact body and returns the original request.
    const body = { requestId: randomUUID(), message: "complete first", attachments: [], dispatchDeadline: deadline() };
    const accepted = await client.requests.submit(sessionId, body);
    expect((await client.requests.submit(sessionId, body)).turnId).toBe(accepted.turnId);
    await expect(client.requests.submit(sessionId, { ...body, message: "changed" })).rejects.toMatchObject({
      code: "idempotency.conflict",
    });
    // Collection is read later than completion and still reports its own settled state.
    await m.settle();
    expect(await client.requests.get(sessionId, body.requestId)).toMatchObject({
      outcome: "completed",
      finalResponse: "done:complete first",
    });
    expect(await client.requests.collection(sessionId, body.requestId)).toMatchObject({ state: "settled" });

    // History snapshot, then events after its watermark, then a reconnect from the last cursor.
    const snapshot = await client.sessions.snapshot(sessionId);
    expect(snapshot.records).toHaveLength(1);
    const running = await client.requests.submit(sessionId, {
      requestId: randomUUID(),
      message: "run long",
      attachments: [],
      dispatchDeadline: deadline(),
    });
    const siblingRequest = await client.requests.submit(sibling, {
      requestId: randomUUID(),
      message: "run sibling",
      attachments: [],
      dispatchDeadline: deadline(),
    });
    await m.settle();
    const controller = new AbortController();
    let last = "";
    for await (const event of client.sessions.events(sessionId, {
      after: snapshot.eventCursor,
      signal: controller.signal,
    })) {
      last = event.cursor;
      if (event.kind === "request.updated" && event.data.state === "running") break;
    }
    controller.abort();
    const cancel = await client.requests.cancel(sessionId, running.requestId, { cancelId: randomUUID() });
    expect(cancel.state).toBe("pending");
    await m.settle();
    const resumed = new AbortController();
    const after: string[] = [];
    for await (const event of client.sessions.events(sessionId, { after: last, signal: resumed.signal })) {
      after.push(event.cursor);
      if (event.kind === "request.updated" && event.data.state === "terminal") break;
    }
    resumed.abort();
    expect(after).not.toContain(last);
    expect((await client.requests.cancel(sessionId, running.requestId, { cancelId: cancel.cancelId })).state).toBe(
      "completed",
    );
    expect((await client.requests.get(sibling, siblingRequest.requestId)).state).toBe("running");

    // An expired cursor is reported so the consumer re-reads history.
    await m.f.store.managed.history.prune(1);
    await expect(
      (async () => {
        for await (const _ of client.sessions.events(sessionId, { after: `${sessionId}:0`, reconnect: false })) break;
      })(),
    ).rejects.toMatchObject({ code: "events.cursor_expired" });

    const close = await client.sessions.close(sessionId, { cancelId: randomUUID() });
    expect(close.scope).toBe("session");
    const error = await client.requests
      .submit(sessionId, { requestId: randomUUID(), message: "late", attachments: [], dispatchDeadline: deadline() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PocketCoderError);
    expect((error as PocketCoderError).code).toBe("session.closed");
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("the SDK provisions capacity budgets and profiles and resumes a session without naming compute", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const { client } = await sdkClient(m);
  try {
    const scopeId = randomUUID();
    await client.authority.grantScope(scopeId, { principalId: m.f.principal.id, installation: false });
    const policy = {
      scopeId,
      revision: 1,
      period: "utc_day" as const,
      limits: {
        workspaceStarts: 3,
        maxActiveWorkspaces: 1,
        maxRunningRequestsPerSession: 1 as const,
        maxChatProcessesPerWorkspace: 2,
      },
    };
    expect((await client.authority.putPolicy(policy, null)).revision).toBe(1);
    expect((await client.authority.putPolicy(policy, null)).revision).toBe(1);
    expect((await client.authority.putPolicy({ ...policy, revision: 2 }, 1)).revision).toBe(2);
    expect((await client.authority.getPolicy(scopeId)).revision).toBe(2);
    expect(await client.authority.usage(m.scopeId)).toMatchObject({ scopeId: m.scopeId, activeWorkspaces: 0 });
    const profile = {
      profileId: randomUUID(),
      revision: 1,
      isolationScopeId: randomUUID(),
      budgetScopeIds: [m.scopeId],
      templateDigest: m.f.runtime.template.digest,
      credentialBindingId: null,
    };
    expect(await client.authority.putProfile(m.f.principal.id, profile)).toEqual(profile);
    const session = await client.sessions.create({
      sessionId: randomUUID(),
      profileId: profile.profileId,
      profileRevision: 1,
    });
    expect(session.state).toBe("provisioning");
    expect((await client.sessions.resume(session.sessionId)).sessionId).toBe(session.sessionId);
    expect(await client.sessions.history(session.sessionId)).toMatchObject({ records: [], nextCursor: null });
  } finally {
    await m.f.dispose();
    await producer.server.stop(true);
  }
});

test("the SDK uploads files late, reports a lost collection and opens previews only on current compute", async () => {
  const producer = fakeProducer();
  const m = await managedFixture(producer.server.port);
  const { client } = await sdkClient(m);
  const other = await m.launch();
  try {
    const unbound = await client.sessions.create({
      sessionId: randomUUID(),
      profileId: m.profileId,
      profileRevision: 1,
    });
    const bytes = new TextEncoder().encode("late input");
    const input = { inputId: randomUUID(), name: "notes.txt", mediaType: "text/plain", bytes };
    const uploaded = await client.files.put(unbound.sessionId, input);
    expect(uploaded.state).toBe("ready");
    expect((await client.files.put(unbound.sessionId, input)).reference).toEqual(uploaded.reference);
    const queued = await client.requests.submit(unbound.sessionId, {
      requestId: randomUUID(),
      message: "use the file",
      attachments: [uploaded.reference],
      dispatchDeadline: deadline(),
    });
    expect((await client.requests.collection(unbound.sessionId, queued.requestId)).state).toBe("pending");
    expect((await client.requests.cancel(unbound.sessionId, queued.requestId, { cancelId: randomUUID() })).state).toBe(
      "completed",
    );
    // Canceled before dispatch: a settled lost collection, never an empty success.
    expect(await client.requests.collection(unbound.sessionId, queued.requestId)).toMatchObject({
      state: "settled",
      completeness: "lost",
      objects: [],
    });
    expect((await client.files.exports(unbound.sessionId, queued.requestId)).items).toEqual([]);
    await expect(client.sessions.openPreview(unbound.sessionId, "web")).rejects.toMatchObject({
      code: "workspace.not_ready",
    });

    // Declare a preview on both fixture workspaces, as a template would.
    for (const id of [m.f.id, other.id]) {
      const row = await m.f.store.getWorkspace(id);
      if (!row) throw Error("Missing workspace");
      await m.f.context.db
        .update(m.f.context.tables.workspaces)
        .set({
          templateSnapshot: {
            ...row.templateSnapshot,
            spec: { ...row.templateSnapshot.spec, previews: { web: { port: 3000 } } },
          },
        })
        .where((await import("drizzle-orm")).eq(m.f.context.tables.workspaces.id, id));
    }
    const bound = await m.session();
    const grant = {
      id: randomUUID(),
      subject: "user-1",
      accessRevision: "1",
      ceilingAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const opened = await client.sessions.openPreview(bound, "web", { grant });
    expect(opened).toMatchObject({ grantId: grant.id });
    expect(new URL(opened.url).searchParams.get("token")).toBeString();
    // The same grant identity cannot be retargeted to another session's compute.
    const elsewhere = randomUUID();
    await m.f.store.managed.sessions.create(m.keyId, {
      sessionId: elsewhere,
      profileId: m.profileId,
      profileRevision: 1,
    });
    await m.f.store.managed.sessions.bind({ principalId: m.f.principal.id, sessionId: elsewhere }, 0, {
      workspaceId: other.id,
      incarnationId: other.runtime.incarnationId,
      generation: 1,
    });
    await expect(client.sessions.openPreview(elsewhere, "web", { grant })).rejects.toBeInstanceOf(PocketCoderError);
  } finally {
    await other.dispose();
    await m.f.dispose();
    await producer.server.stop(true);
  }
});
