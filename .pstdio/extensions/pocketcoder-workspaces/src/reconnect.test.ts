import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createRemoteHarness } from "./agent";
import { startController } from "./controller-fixture";
import { remoteWorkspace as provider, remoteRef } from "./workspace";

test.each(["resume", "reattach"] as const)(
  "recovers through %s without repeating accepted prompts",
  async (mode) => {
    const fixture = await startController();
    const { ctx, harnessCtx, settings, template, requests } = fixture;
    const input = { workspaceId: randomUUID(), projectId: ctx.projectId, operationId: randomUUID(), params: {} };
    const harness = createRemoteHarness();
    const replacement = createRemoteHarness();
    let created: Awaited<ReturnType<typeof provider.create>> | undefined;
    try {
      template.spec.version = "2.0.0";
      template.spec.harness.command = [
        "bun",
        "-e",
        `
      let status = "stable";
      const messages = [];
      Bun.serve({ hostname: "127.0.0.1", port: 3284, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/status") return Response.json({ status });
        if (path === "/messages") return Response.json({ messages });
        if (path === "/message") {
          const { content } = await request.json();
          messages.push({ role: "user", content });
          status = "running";
          setTimeout(() => { messages.push({ role: "agent", content: "done: " + content }); status = "stable"; }, 2000);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      }});
    `,
      ];
      expect(
        (
          await fixture.request("pocketcoder", {
            method: "POST",
            path: "/v1/templates",
            body: { manifest: template },
          })
        ).status,
      ).toBe(201);
      settings.templateVersion = template.spec.version;
      created = await provider.create(ctx, input);
      if (!created.providerRef || created.executionTarget?.kind !== "remote") throw new Error("Missing target");
      const ref = remoteRef(created.providerRef);
      const events = { push() {}, getMessages: () => [] };
      const sessionId = randomUUID();
      const workspace = { workspaceId: input.workspaceId, executionTarget: created.executionTarget };
      const session = await harness.start(harnessCtx, { workspace, sessionId, prompt: "one turn", events });
      const deadline = Date.now() + 10_000;
      let running = false;
      while (!running && Date.now() < deadline) {
        const status = await fixture.request<{ status: string }>("pocketcoder", {
          method: "GET",
          path: `/v1/workspaces/${ref.remoteId}/agent/status`,
        });
        running = status.body.status === "running";
        if (!running) await Bun.sleep(20);
      }
      expect(running).toBe(true);
      await harness.dispose(harnessCtx);
      expect(await session.done).toEqual({ status: "disconnected" });
      expect((await provider.resolve(ctx, { ...input, providerRef: created.providerRef })).state).toBe("ready");
      const recovery = { workspace, sessionId, agentSessionId: session.agentSessionId ?? "", events };
      const attached =
        mode === "resume"
          ? await replacement.resume(harnessCtx, { ...recovery, prompt: "new follow up" })
          : await replacement.reattach(harnessCtx, recovery);
      expect(await attached.done).toEqual({ status: "completed" });
      const sent = requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/agent/message"));
      expect(sent.map((entry) => entry.body)).toEqual(
        mode === "resume"
          ? [
              { content: "one turn", type: "user" },
              { content: "new follow up", type: "user" },
            ]
          : [{ content: "one turn", type: "user" }],
      );
      expect(
        JSON.stringify(
          await replacement.getMessages(harnessCtx, {
            workspace,
            agentSessionId: session.agentSessionId ?? "",
          }),
        ),
      ).toContain("done: one turn");
    } finally {
      await harness.dispose(harnessCtx);
      await replacement.dispose(harnessCtx);
      if (created?.providerRef) await provider.delete(ctx, { ...input, providerRef: created.providerRef });
      await fixture.stop();
    }
  },
  180_000,
);
