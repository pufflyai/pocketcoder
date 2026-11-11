import type { ExecutionRecord, WorkspaceRequest } from "@pstdio/pocketcoder-sdk";
import {
  defineHarness,
  type HarnessContext,
  type HarnessReattachInput,
  type HarnessSession,
  type HarnessStartInput,
  reconcileMessageHistory,
} from "@pstdio/sdk/extensions";
import { request, workspacePath } from "./connection";
import { createHarnessRuns } from "./harness-runs";
import { readSessionMessages } from "./messages";
import { readWorkspace, remoteRef } from "./workspace";

export function createRemoteHarness() {
  const runs = createHarnessRuns();
  const target = (
    ctx: HarnessContext,
    input: { workspace?: HarnessStartInput["workspace"]; agentSessionId?: string },
  ) => {
    const execution = input.workspace?.executionTarget;
    if (
      !ctx.projectId ||
      execution?.kind !== "remote" ||
      execution.providerId !== `${ctx.extensionId}.workspace-type.remote`
    )
      throw new Error("Choose a PocketCoder workspace.");
    const ref = remoteRef(execution.providerRef);
    if (
      input.workspace?.workspaceId !== ref.workspaceId ||
      (input.agentSessionId && !input.agentSessionId.startsWith(`${ref.remoteId}:`))
    )
      throw new Error("This session belongs to another workspace.");
    return ref;
  };
  type Ref = ReturnType<typeof target>;
  type Pending = { remoteId: string; request: WorkspaceRequest; cancelId?: string };
  const key = (sessionId: string) => `request:${sessionId}`;
  const messages = (ctx: HarnessContext, ref: Ref, conversationId: string) =>
    readSessionMessages(<T>(path: string) => request<T>(ctx, { method: "GET", path }), ref.remoteId, conversationId);
  const attach = (
    ctx: HarnessContext,
    input: HarnessStartInput | HarnessReattachInput,
    ref: Ref,
    pending: Pending,
  ): HarnessSession => {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const base = `${workspacePath(ref.remoteId)}/requests`;
    const submit = () => request<ExecutionRecord>(ctx, { method: "POST", path: base, body: pending.request, signal });
    const done = (async () => {
      await submit();
      while (!signal.aborted) {
        const receipt = await request<ExecutionRecord>(ctx, {
          method: "GET",
          path: `${base}/${pending.request.requestId}?conversationId=${pending.request.conversationId}`,
          signal,
        });
        input.events.push({
          op: "replace",
          path: "/messages",
          value: await messages(ctx, ref, pending.request.conversationId),
        });
        if (receipt.finalizedAt) {
          await ctx.state.delete(key(input.sessionId));
          return completedStatus(receipt);
        }
        await Bun.sleep(250);
      }
      return { status: "disconnected" as const };
    })().catch(() => ({ status: "disconnected" as const }));
    return {
      agentSessionId: `${ref.remoteId}:${pending.request.conversationId}`,
      timeoutStrategy: "provider",
      done,
      async stop() {
        pending.cancelId ??= crypto.randomUUID();
        await ctx.state.set(key(input.sessionId), pending);
        const receipt = await submit();
        const execution = receipt.acceptance.execution;
        await request(ctx, {
          method: "POST",
          path: `${workspacePath(ref.remoteId)}/executions/${execution.requestId}/cancel`,
          body: { execution, cancelId: pending.cancelId, scope: "operation" },
        });
      },
    };
  };
  const send = async (ctx: HarnessContext, input: HarnessStartInput & { agentSessionId?: string }) => {
    const ref = target(ctx, input);
    if (input.attachments?.length) throw new Error("Use the Lab connection to upload file inputs.");
    if (await ctx.state.get(key(input.sessionId)))
      throw new Error("Reconnect to the pending request before sending another message.");
    let machine = await readWorkspace(ctx, ref, input.signal);
    while (machine.state !== "ready") {
      if (!["queued", "provisioning", "connected"].includes(machine.state))
        throw new Error(`Workspace is ${machine.state}.`);
      const change = await request<{ workspace: typeof machine }>(ctx, {
        method: "GET",
        path: `${workspacePath(ref.remoteId)}/changes?after=${machine.change_cursor}&wait=30`,
        timeoutMs: 35_000,
        signal: input.signal,
      });
      machine = change.workspace;
    }
    const conversationId = input.agentSessionId?.slice(ref.remoteId.length + 1) || crypto.randomUUID();
    if (!input.prompt.trim())
      return {
        agentSessionId: `${ref.remoteId}:${conversationId}`,
        done: Promise.resolve({ status: "completed" as const }),
        stop() {},
      };
    const pending: Pending = {
      remoteId: ref.remoteId,
      request: { requestId: crypto.randomUUID(), conversationId, message: input.prompt, files: [] },
    };
    await ctx.state.set(key(input.sessionId), pending);
    return attach(ctx, input, ref, pending);
  };
  return defineHarness({
    id: "agent",
    label: "PocketCoder workspace agent",
    cwdRequirement: "optional",
    capabilities: () => ["SessionReattach"],
    start: (ctx, input) => runs.run(ctx, input, (active) => send(ctx, active)),
    resume: (ctx, input) =>
      runs.run(ctx, input, async (active) => {
        const ref = target(ctx, active);
        const pending = await ctx.state.get<Pending>(key(active.sessionId));
        if (!pending) return send(ctx, active);
        if (pending.remoteId !== ref.remoteId) throw new Error("Pending request belongs to another workspace.");
        let current = attach(ctx, active, ref, pending);
        if (!active.prompt.trim() || active.prompt === pending.request.message) return current;
        const recovered = current;
        let stopped = false;
        return {
          ...recovered,
          async stop() {
            stopped = true;
            await current.stop();
          },
          done: (async () => {
            const result = await recovered.done;
            if (stopped || result.status === "disconnected") return result;
            current = await send(ctx, active);
            if (stopped) await current.stop();
            return current.done;
          })(),
        };
      }),
    reattach: (ctx, input) =>
      runs.run(ctx, input, async (active) => {
        const ref = target(ctx, active);
        const pending = await ctx.state.get<Pending>(key(active.sessionId));
        if (!pending || pending.remoteId !== ref.remoteId) throw new Error("No pending PocketCoder request was found.");
        return attach(ctx, active, ref, pending);
      }),
    dispose: runs.dispose,
    async getMessages(ctx, input) {
      const ref = target(ctx, input);
      const id = input.agentSessionId.slice(ref.remoteId.length + 1);
      return id ? messages(ctx, ref, id) : [];
    },
    recoverMessages: (_ctx, input) => reconcileMessageHistory(input),
  });
}

function completedStatus(receipt: ExecutionRecord) {
  if (receipt.phase === "canceled") return { status: "cancelled" as const };
  if (
    receipt.outcome &&
    typeof receipt.outcome === "object" &&
    "status" in receipt.outcome &&
    receipt.outcome.status === "completed"
  )
    return { status: "completed" as const };
  return { status: "failed" as const };
}
