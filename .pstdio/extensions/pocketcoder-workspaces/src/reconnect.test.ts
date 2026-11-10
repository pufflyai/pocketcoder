import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRemoteHarness } from "./agent";
import { startController } from "./controller-fixture";
import { remoteWorkspace as provider } from "./workspace";

test.each(["resume", "reattach", "stop"] as const)(
  "recovers through %s without repeating an accepted prompt",
  async (mode) => {
    const gate = Promise.withResolvers<void>();
    const fixture = await startController({ holdFirstSubmission: gate.promise });
    const { ctx, harnessCtx, requests } = fixture;
    const input = { workspaceId: randomUUID(), projectId: ctx.projectId, operationId: randomUUID(), params: {} };
    const harness = createRemoteHarness();
    const replacement = createRemoteHarness();
    let created: Awaited<ReturnType<typeof provider.create>> | undefined;
    try {
      created = await provider.create(ctx, input);
      if (!created.providerRef || created.executionTarget?.kind !== "remote") throw new Error("Missing target");
      const workspace = { workspaceId: input.workspaceId, executionTarget: created.executionTarget };
      const sessionId = randomUUID();
      const events = { push() {}, getMessages: () => [] };
      const session = await harness.start(harnessCtx, { workspace, sessionId, prompt: "one turn", events });
      const deadline = Date.now() + 30_000;
      while (!fixture.submissionHeld) {
        if (Date.now() > deadline) throw new Error("No native request submitted");
        await Bun.sleep(10);
      }
      const disposing = harness.dispose(harnessCtx);
      gate.resolve();
      await disposing;
      expect(await session.done).toEqual({ status: "disconnected" });
      const recovery = { workspace, sessionId, agentSessionId: session.agentSessionId ?? "", events };
      const attached =
        mode !== "reattach"
          ? await replacement.resume(harnessCtx, { ...recovery, prompt: "new follow up" })
          : await replacement.reattach(harnessCtx, recovery);
      if (mode === "stop") await attached.stop();
      const result = await attached.done;
      if (mode === "stop") expect(["completed", "cancelled"]).toContain(result.status);
      else expect(result).toEqual({ status: "completed" });
      const sent = requests
        .filter((r) => r.method === "POST" && r.path.endsWith("/requests"))
        .map((r) => r.body as { requestId: string; message: string });
      expect(new Set(sent.filter((r) => r.message === "one turn").map((r) => r.requestId)).size).toBe(1);
      expect(new Set(sent.map((r) => r.requestId)).size).toBe(mode === "resume" ? 2 : 1);
      expect(JSON.stringify(await replacement.getMessages(harnessCtx, recovery))).toContain(
        mode === "stop" ? "one turn" : "echo: one turn",
      );
    } finally {
      gate.resolve();
      await harness.dispose(harnessCtx);
      await replacement.dispose(harnessCtx);
      if (created?.providerRef) await provider.delete(ctx, { ...input, providerRef: created.providerRef });
      await fixture.stop();
    }
  },
  180_000,
);
