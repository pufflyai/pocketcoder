import {
  defineHarness,
  type HarnessContext,
  type HarnessExit,
  type HarnessReattachInput,
  type HarnessSession,
  type HarnessStartInput,
  reconcileMessageHistory,
} from "@pstdio/sdk/extensions";
import { isTerminal, PocketCoderRequestError, request, workspacePath } from "./connection";
import { createHarnessRuns } from "./harness-runs";
import { history, isAssistant, messages, messagesFor } from "./messages";
import { readWorkspace, remoteRef } from "./workspace";

const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 500);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });

async function submit(ctx: HarnessContext, remoteId: string, prompt: string | undefined, signal: AbortSignal) {
  if (prompt === undefined) return true;
  try {
    await request(ctx, {
      method: "POST",
      path: `${workspacePath(remoteId)}/agent/message`,
      body: { content: prompt, type: "user" },
      signal,
    });
    return true;
  } catch (error) {
    // Definitive rejections cannot produce a reply; transport failures may have been accepted.
    if (error instanceof PocketCoderRequestError && error.status >= 400 && error.status < 500) return false;
    throw error;
  }
}

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
      throw new Error("Choose a PocketCoder workspace from the Workspaces extension.");
    const ref = remoteRef(execution.providerRef);
    if (
      input.workspace?.workspaceId !== ref.workspaceId ||
      (input.agentSessionId && input.agentSessionId !== ref.remoteId)
    )
      throw new Error("This session belongs to another workspace.");
    return ref;
  };
  type Ref = ReturnType<typeof target>;
  const cursorKey = (ctx: HarnessContext, sessionId: string) => `turn:${ctx.projectId}:${sessionId}`;
  const attach = (
    ctx: HarnessContext,
    input: HarnessStartInput | HarnessReattachInput,
    ref: Ref,
    baseline: number,
    prompt?: string,
  ) => {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const poll = async (): Promise<HarnessExit> => {
      if (!(await submit(ctx, ref.remoteId, prompt, signal))) return { status: "failed" };
      while (!signal.aborted) {
        const machine = await readWorkspace(ctx, ref, signal);
        if (isTerminal(machine)) {
          input.events.push({ op: "replace", path: "/messages", value: await history(ctx, ref) });
          return { status: machine.state === "canceled" ? "cancelled" : "failed" };
        }
        const current = await messages(ctx, ref, signal);
        input.events.push({ op: "replace", path: "/messages", value: messagesFor(ref.remoteId, current) });
        const status = await request<{ status: string }>(ctx, {
          method: "GET",
          path: `${workspacePath(ref.remoteId)}/agent/status`,
          signal,
        });
        if (status.status === "stable" && current.slice(baseline).some(isAssistant)) {
          input.events.push({
            op: "replace",
            path: "/messages",
            value: messagesFor(ref.remoteId, await messages(ctx, ref, signal)),
          });
          return { status: "completed" };
        }
        await pause(signal);
      }
      return { status: "disconnected" };
    };
    const done = poll()
      .catch(() => {
        if (!signal.aborted) ctx.logger.warn("PocketCoder connection ended. Reconnect to read the accepted turn.");
        return { status: "disconnected" as const };
      })
      .then(async (exit) => {
        if (exit.status !== "disconnected") await ctx.state.delete(cursorKey(ctx, input.sessionId));
        return exit;
      });
    return {
      agentSessionId: ref.remoteId,
      done,
      stop: () => controller.abort(),
      timeoutStrategy: "provider",
    } satisfies HarnessSession;
  };
  const send = async (ctx: HarnessContext, input: HarnessStartInput & { agentSessionId?: string }) => {
    const ref = target(ctx, input);
    if (input.attachments?.length) throw new Error("Attachments are not supported by this agent connection.");
    if (await ctx.state.get(cursorKey(ctx, input.sessionId)))
      throw new Error("A turn may still be running. Reconnect before sending another prompt.");
    let machine = await readWorkspace(ctx, ref, input.signal);
    while (machine.state !== "ready" || machine.agent_state !== "stable") {
      if (isTerminal(machine)) throw new Error(`Workspace is ${machine.state}.`);
      await request(ctx, {
        method: "GET",
        path: `${workspacePath(ref.remoteId)}/changes?after=${machine.change_cursor}&wait=30`,
        timeoutMs: 35_000,
        signal: input.signal,
      });
      machine = await readWorkspace(ctx, ref, input.signal);
    }
    const current = await messages(ctx, ref, input.signal);
    if (!input.prompt.trim()) {
      input.events.push({ op: "replace", path: "/messages", value: messagesFor(ref.remoteId, current) });
      return { agentSessionId: ref.remoteId, done: Promise.resolve({ status: "completed" as const }), stop() {} };
    }
    await ctx.state.set(cursorKey(ctx, input.sessionId), { remoteId: ref.remoteId, baseline: current.length });
    return attach(ctx, input, ref, current.length, input.prompt);
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
        const cursor = await ctx.state.get<{ remoteId: string; baseline: number }>(cursorKey(ctx, active.sessionId));
        if (!cursor) return send(ctx, active);
        if (cursor.remoteId !== ref.remoteId) throw new Error("This pending turn belongs to another workspace.");
        await readWorkspace(ctx, ref, active.signal);
        const controller = new AbortController();
        const signal = active.signal ? AbortSignal.any([active.signal, controller.signal]) : controller.signal;
        const pending = attach(ctx, { ...active, signal }, ref, cursor.baseline);
        return {
          agentSessionId: ref.remoteId,
          timeoutStrategy: "provider" as const,
          stop: () => controller.abort(),
          // Finish observing accepted work before delivering the caller's new follow-up.
          done: pending.done.then(async (exit) => {
            if (exit.status !== "completed" || signal.aborted || !active.prompt.trim()) return exit;
            return (await send(ctx, { ...active, signal })).done;
          }),
        };
      }),
    reattach: (ctx, input) =>
      runs.run(ctx, input, async (active) => {
        const ref = target(ctx, active);
        try {
          await readWorkspace(ctx, ref, active.signal);
        } catch (error) {
          if (error instanceof PocketCoderRequestError && error.status < 500 && error.status !== 429) throw error;
          if (active.signal?.aborted) throw error;
          throw Object.assign(new Error("PocketCoder is temporarily unreachable."), { retryable: true });
        }
        const cursor = await ctx.state.get<{ remoteId: string; baseline: number }>(cursorKey(ctx, active.sessionId));
        if (!cursor || cursor.remoteId !== ref.remoteId) throw new Error("No pending turn was found.");
        return attach(ctx, active, ref, cursor.baseline);
      }),
    dispose: runs.dispose,
    async getMessages(ctx, input) {
      const ref = target(ctx, input);
      const machine = await readWorkspace(ctx, ref);
      return isTerminal(machine) ? history(ctx, ref) : messagesFor(ref.remoteId, await messages(ctx, ref));
    },
    recoverMessages: (_ctx, input) => reconcileMessageHistory(input),
  });
}
