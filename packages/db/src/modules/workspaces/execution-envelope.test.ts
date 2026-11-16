import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, executionAcceptEnvelope, executionInputManifestId } from "@pstdio/pocketcoder-contracts";
import { sessionWorkFixture } from "../sessions/work-fixture.test";
import { executionFixture } from "./execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "./execution-service-fixture.test";

test.each(["a", "界", '\\"'])("service admission checks exact UTF-8 envelope bytes for %s", async (seed) => {
  const f = await envelopeFixture();
  try {
    const { fingerprint: _, ...facts } = f.acceptance();
    const identity = executionConversationIdentity(facts.execution.requestId);
    facts.input = { prompt: seed };
    const build = () => ({ ...facts, fingerprint: digestOf(facts) });
    const bytes = () => Buffer.byteLength(JSON.stringify({ acceptance: build(), conversationIdentity: identity }));
    const prompt = seed + "x".repeat(2048 - bytes());
    facts.input = { prompt };
    expect(bytes()).toBe(2048);
    const accepted = build();
    facts.input = { prompt: `${prompt}x` };
    const oversized = build();
    await expect(f.store.executions.accept(oversized, new Date(), identity)).rejects.toThrow("route limit");
    expect(await f.store.executions.get(oversized.execution)).toBeNull();
    expect(await f.store.inputs.getManifest(executionInputManifestId(oversized))).toBeNull();
    expect((await f.store.executions.accept(accepted, new Date(), identity)).kind).toBe("accepted");
  } finally {
    await f.dispose();
  }
});

test("service admission includes the trusted input-directory field before creating pins", async () => {
  const f = await envelopeFixture(true);
  try {
    const { fingerprint: _, ...facts } = f.acceptance();
    const identity = executionConversationIdentity(facts.execution.requestId);
    const { digest: _digest, ...contents } = facts.inputs;
    contents.objects = [
      {
        workspaceId: f.id,
        fileId: randomUUID(),
        objectVersion: digestOf("object-version"),
        name: "input.txt",
        mediaType: "text/plain",
        sizeBytes: 3,
        digest: digestOf("abc"),
        visibility: "ready",
      },
    ];
    facts.inputs = { ...contents, digest: digestOf(contents) };
    facts.input = { prompt: "" };
    const build = () => ({ ...facts, fingerprint: digestOf(facts) });
    const bytes = Buffer.byteLength(JSON.stringify({ acceptance: build(), conversationIdentity: identity }));
    facts.input = { prompt: "x".repeat(2048 - bytes) };
    const acceptance = build();
    expect(Buffer.byteLength(JSON.stringify({ acceptance, conversationIdentity: identity }))).toBe(2048);
    await expect(f.store.executions.accept(acceptance, new Date(), identity)).rejects.toThrow("route limit");
    expect(await f.store.executions.get(acceptance.execution)).toBeNull();
    expect(await f.store.inputs.getManifest(executionInputManifestId(acceptance))).toBeNull();
  } finally {
    await f.dispose();
  }
});

test.each(["lookup", "cancel", "ack"])("service admission refuses an unusable %s envelope budget", async (action) => {
  const f = await envelopeFixture(false, action);
  try {
    const { fingerprint: _, ...facts } = f.acceptance();
    facts.input = { prompt: "small" };
    const acceptance = { ...facts, fingerprint: digestOf(facts) };
    await expect(
      f.store.executions.accept(acceptance, new Date(), executionConversationIdentity(acceptance.execution.requestId)),
    ).rejects.toThrow("route limit");
    expect(await f.store.executions.get(acceptance.execution)).toBeNull();
    expect(await f.store.inputs.getManifest(executionInputManifestId(acceptance))).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("managed attachment metadata fits the route before dispatch can create a pin or claim", async () => {
  const f = await sessionWorkFixture("memory", false, (source) => {
    const route = source.spec.services.agent?.routes.find((route) => route.path === "/executions/accept");
    if (!route) throw new Error("Missing accept route");
    route.maxRequestBytes = 2048;
  });
  try {
    await f.store.managed.sessions.bind({ principalId: f.principal.id, sessionId: f.sessionId }, 0, {
      workspaceId: f.id,
      incarnationId: f.runtime.incarnationId,
      generation: 1,
    });
    const { fingerprint: _, ...facts } = f.acceptance();
    facts.operation = "message";
    facts.input = { message: "x" };
    const identity = {
      ...executionConversationIdentity(facts.execution.requestId, f.sessionId),
      authority: "generic" as const,
    };
    const build = () => ({ ...facts, fingerprint: digestOf(facts) });
    const size = Buffer.byteLength(JSON.stringify(executionAcceptEnvelope(build(), identity)));
    facts.input = { message: "x".repeat(2048 - size + 1) };
    expect(Buffer.byteLength(JSON.stringify(executionAcceptEnvelope(build(), identity)))).toBe(2048);
    const accepted = await f.store.managed.requests.accept(
      f.keyId,
      f.sessionId,
      {
        requestId: randomUUID(),
        message: String(facts.input.message),
        attachments: [],
      },
      { count: 2, bytes: 1048576 },
    );

    await f.store.managed.requests.prepare(new Date());

    expect(await f.store.managed.requests.get(f.keyId, f.sessionId, accepted.request.requestId)).toMatchObject({
      state: "terminal",
      outcome: "failed",
      reasonCode: "execution_authority_unavailable",
    });
    expect(await f.store.executions.pending()).toEqual([]);
    expect(
      await f.store.inputs.getManifest(
        executionInputManifestId({
          ...facts,
          execution: { ...facts.execution, requestId: accepted.request.turnId },
        }),
      ),
    ).toBeNull();
  } finally {
    await f.dispose();
  }
});

function envelopeFixture(files = false, undersizedControl?: string) {
  return executionFixture(
    (source) => {
      serviceExecutionTemplate(source);
      const operation = source.spec.operations.run;
      const route = source.spec.services.agent?.routes.find((r) => r.path === "/executions/accept");
      if (!operation || !route) throw new Error("Fixture operation missing");
      operation.inputSchema = {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
        additionalProperties: false,
      };
      route.maxRequestBytes = 2048;
      if (undersizedControl) {
        const control = source.spec.services.agent?.routes.find((r) => r.path === `/executions/${undersizedControl}`);
        if (!control) throw new Error("Fixture control route missing");
        control.maxRequestBytes = 64;
      }
    },
    files
      ? {
          capabilities: [
            "explicit-start",
            "targeted-cancel",
            "request-lookup",
            "deduplicated-accept",
            "unknown-outcome",
            "immutable-inputs",
          ],
        }
      : {},
  );
}
