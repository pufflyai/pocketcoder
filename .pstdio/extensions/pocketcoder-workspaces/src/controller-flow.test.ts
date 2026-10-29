import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JsonPatch } from "@pstdio/sdk/extensions";
import { createRemoteHarness } from "./agent";
import { connectWorkspace } from "./commands";
import { startController } from "./controller-fixture";
import { workspacesView } from "./workbench";
import { remoteWorkspace as provider, readWorkspace, remoteRef } from "./workspace";

test("uses the fixed template through a controller without Lab, chats and cleans up", async () => {
  const fixture = await startController();
  const { ctx, harnessCtx, settings, requests } = fixture;
  const harness = createRemoteHarness();
  const input = { workspaceId: randomUUID(), projectId: ctx.projectId, operationId: randomUUID(), params: {} };
  let created: Awaited<ReturnType<typeof provider.create>> | undefined;
  try {
    await expect(provider.create(ctx, { ...input, params: { template: "unreviewed" } })).rejects.toThrow("Unsupported");
    created = await provider.create(ctx, input);
    expect((await provider.create(ctx, input)).providerRef).toEqual(created.providerRef);
    if (!created.providerRef || created.executionTarget?.kind !== "remote") throw new Error("Missing target");
    expect(requests.filter((entry) => entry.path === "/v1/workspaces").map((entry) => entry.body)).toEqual([
      { external_id: input.workspaceId, template: { name: settings.templateName, version: settings.templateVersion } },
      { external_id: input.workspaceId, template: { name: settings.templateName, version: settings.templateVersion } },
    ]);
    const ref = remoteRef(created.providerRef);
    await expect(readWorkspace(ctx, { ...ref, workspaceId: "wrong-owner" })).rejects.toThrow("another");
    const workspace = { workspaceId: input.workspaceId, executionTarget: created.executionTarget };
    const patches: JsonPatch[] = [];
    const events = { push: (patch: JsonPatch) => patches.push(patch), getMessages: () => [] };
    const sessionId = randomUUID();
    const rejected = await harness.start(harnessCtx, {
      workspace,
      sessionId,
      prompt: "x".repeat(100_000),
      events,
    });
    expect(await rejected.done).toEqual({ status: "failed" });
    const first = await harness.start(harnessCtx, { workspace, sessionId, prompt: "hello from product", events });
    expect(await first.done).toEqual({ status: "completed" });
    expect(JSON.stringify(patches)).toContain("echo: hello from product");
    const next = await harness.resume(harnessCtx, {
      workspace,
      sessionId,
      agentSessionId: first.agentSessionId ?? "",
      prompt: "follow up",
      events,
    });
    expect(await next.done).toEqual({ status: "completed" });
    const labTarget = {
      ...workspace,
      executionTarget: { ...workspace.executionTarget, providerId: "pocketcoder.pocketcoder.workspace-type.machine" },
    };
    await expect(
      harness.start(harnessCtx, { workspace: labTarget, sessionId, prompt: "wrong provider", events }),
    ).rejects.toThrow("Workspaces extension");
    settings.templateName = "changed-for-new-workspaces";
    expect((await provider.resolve(ctx, { ...input, providerRef: created.providerRef })).state).toBe("ready");
    await provider.delete(ctx, { ...input, providerRef: created.providerRef });
    const cached = {
      id: input.workspaceId,
      provider_id: `${ctx.extensionId}.workspace-type.remote`,
      provider_state: "ready" as const,
    };
    const saved = created;
    ctx.workspaces.get = async () => cached;
    ctx.workspaces.list = async () => [cached];
    ctx.workspaces.resolve = async () => ({ ...saved, state: "ready" });
    await expect(connectWorkspace.run(ctx, { workspaceId: input.workspaceId })).rejects.toThrow("canceled");
    if (workspacesView.body.kind !== "dataTable") throw new Error("Missing workspace table");
    const rows = await workspacesView.body.query(ctx);
    expect(rows.rows[0]?.values.state).toBe("cancelled");
    expect((await provider.resolve(ctx, { ...input, providerRef: created.providerRef })).state).toBe("cancelled");
    expect(
      JSON.stringify(
        await harness.getMessages(harnessCtx, {
          workspace,
          agentSessionId: first.agentSessionId ?? "",
        }),
      ),
    ).toContain("echo: follow up");
  } finally {
    await harness.dispose(harnessCtx);
    if (created?.providerRef) await provider.delete(ctx, { ...input, providerRef: created.providerRef });
    await fixture.stop();
  }
}, 180_000);
