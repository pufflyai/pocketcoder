import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { digestOf, executionInputManifestId } from "@pstdio/pocketcoder-contracts";
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
