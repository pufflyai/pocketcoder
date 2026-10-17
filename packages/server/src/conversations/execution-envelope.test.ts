import { expect, test } from "bun:test";
import { issueMachineKey } from "@pstdio/pocketcoder-auth";
import { digestOf, executionInputManifestId, type WorkloadAcceptance } from "@pstdio/pocketcoder-contracts";
import { executionConversationIdentity, serviceExecutionTemplate } from "@pstdio/pocketcoder-db/testing";
import { DockerDriver } from "@pstdio/pocketcoder-drivers";
import { DEFAULT_LIMITS } from "@pstdio/pocketcoder-runtime-core";
import { buildServer } from "../app";
import { processDispatchFixture } from "../control-channel/process-dispatch-fixture.test";
import { authed } from "../testing/test-server.test";

test.each(["x".repeat(70_000), "🙂".repeat(18_000)])(
  "oversized service input rejects before durable intent and leaves the next request usable",
  async (prompt) => {
    let accepts = 0;
    const producer = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/status") return Response.json({ status: "stable" });
        accepts++;
        const payload = await request.text();
        expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(65536);
        const { acceptance } = JSON.parse(payload) as { acceptance: WorkloadAcceptance };
        return Response.json({
          execution: acceptance.execution,
          fingerprint: acceptance.fingerprint,
          phase: "running",
          outcome: null,
        });
      },
    });
    const f = await processDispatchFixture((source) => {
      serviceExecutionTemplate(source, Number(producer.url.port));
      const operation = source.spec.operations.run;
      if (!operation) throw new Error("Fixture operation missing");
      operation.inputSchema = {
        type: "object",
        properties: { prompt: { type: "string" } },
        required: ["prompt"],
        additionalProperties: false,
      };
    });
    try {
      const key = issueMachineKey("execution-envelope-fixture");
      await f.store.insertMachineKey({
        id: key.id,
        principalId: f.principal.id,
        secretDigest: key.secretDigest,
        scopes: [],
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        lastUsedAt: null,
      });
      const { app } = buildServer({
        store: f.store,
        driver: new DockerDriver(),
        pepper: "execution-envelope-fixture",
        limits: DEFAULT_LIMITS,
        workspaceServerUrl: "http://localhost",
      });
      const start = (text: string) => {
        const { fingerprint: _, ...facts } = f.acceptance();
        facts.input = { prompt: text };
        const acceptance = { ...facts, fingerprint: digestOf(facts) };
        return { acceptance, conversationIdentity: executionConversationIdentity(acceptance.execution.requestId) };
      };
      const request = (body: ReturnType<typeof start>) =>
        app.request(
          `/v1/workspaces/${f.id}/executions`,
          authed(key.token, { method: "POST", body: JSON.stringify(body) }),
        );
      const large = start(prompt);
      expect((await request(large)).status).toBe(413);
      expect(await f.store.executions.get(large.acceptance.execution)).toBeNull();
      expect(await f.store.inputs.getManifest(executionInputManifestId(large.acceptance))).toBeNull();
      await f.dispatcher.tick();
      await f.dispatcher.drain();
      expect(accepts).toBe(0);
      const small = start("small");
      expect((await request(small)).status).toBe(201);
      await f.dispatcher.tick();
      await f.dispatcher.drain();
      expect(accepts).toBe(1);
      expect(f.dispatchFailed).toBe(false);
      expect((await f.store.executions.get(small.acceptance.execution))?.phase).toBe("running");
    } finally {
      await f.dispose();
      await producer.stop(true);
    }
  },
);
