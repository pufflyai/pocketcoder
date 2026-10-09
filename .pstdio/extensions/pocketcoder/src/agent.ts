import {
  defineHarness,
  type HarnessContext,
  type HarnessExit,
  type HarnessReattachInput,
  type HarnessSession,
  type HarnessStartInput,
  reconcileMessageHistory,
  type SessionMessage,
  type SessionMessageRole,
} from "@pstdio/sdk/extensions";
import { createHarnessRuns } from "./harness-runs";
import { instancesFor } from "./instances";
import { isTerminal, type Machine, machinePath, machineRef } from "./machines";

interface AgentMessage {
  id?: number;
  role: string;
  content: string;
}
const assistant = (message: AgentMessage) => message.role === "agent" || message.role === "assistant";

export const normalizeMessages = (id: string, messages: AgentMessage[]) =>
  messages.map(
    (message, index) =>
      ({
        id: `pocketcoder:${id}:${message.id ?? index}`,
        role: (assistant(message) ? "assistant" : message.role) as SessionMessageRole,
        index,
        parts: [{ type: "text" as const, text: message.content }],
      }) satisfies SessionMessage,
  );

export const turnFinished = (messages: AgentMessage[], baseline: number, status: string) =>
  status === "stable" && messages.slice(baseline).some(assistant);

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

export function createMachineHarness(getInstances = instancesFor) {
  const runs = createHarnessRuns();
  const target = (
    ctx: HarnessContext,
    input: { workspace?: HarnessStartInput["workspace"]; agentSessionId?: string },
  ) => {
    const execution = input.workspace?.executionTarget;
    if (
      !ctx.projectId ||
      execution?.kind !== "remote" ||
      execution.providerId !== `${ctx.extensionId}.workspace-type.machine`
    )
      throw new Error("Choose a PocketCoder agent machine.");
    const ref = machineRef(execution.providerRef);
    const sessionId = `${ref.instanceId}:${ref.machineId}`;
    if (input.agentSessionId && input.agentSessionId !== sessionId)
      throw new Error("This agent session belongs to another machine.");
    return { ...ref, sessionId, instances: getInstances(ctx.projectId) };
  };
  type Target = ReturnType<typeof target>;
  const readMessages = async (ref: Target, signal?: AbortSignal) => {
    const response = await ref.instances.request<{ messages: AgentMessage[] }>(
      ref.instanceId,
      `${machinePath(ref.machineId)}/agent/messages`,
      { signal },
    );
    return response.messages;
  };
  const history = async (ref: Target) => {
    const messages: SessionMessage[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "200" });
      if (cursor) query.set("cursor", cursor);
      const page: {
        items: { message_id: string; role: SessionMessageRole; content: string; occurred_at: string }[];
        next_cursor: string | null;
      } = await ref.instances.request(ref.instanceId, `${machinePath(ref.machineId)}/conversation?${query}`);
      for (const message of page.items)
        messages.push({
          id: `pocketcoder:${ref.machineId}:${message.message_id}`,
          role: message.role,
          index: messages.length,
          parts: [{ type: "text", text: message.content }],
          createdAt: Date.parse(message.occurred_at),
        });
      cursor = page.next_cursor;
    } while (cursor);
    return messages;
  };
  const attach = (
    ctx: HarnessContext,
    input: HarnessStartInput | HarnessReattachInput,
    ref: Target,
    baseline: number,
    prompt?: string,
  ) => {
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const cursorKey = `turn:${input.sessionId}`;
    const stop = () => {
      controller.abort();
    };
    const poll = async (): Promise<HarnessExit> => {
      if (prompt !== undefined)
        await ref.instances.request(ref.instanceId, `${machinePath(ref.machineId)}/agent/message`, {
          method: "POST",
          body: JSON.stringify({ content: prompt, type: "user" }),
          signal,
        });
      while (!signal.aborted) {
        const machine = await ref.instances.request<Machine>(ref.instanceId, machinePath(ref.machineId), { signal });
        if (isTerminal(machine)) {
          input.events.push({ op: "replace", path: "/messages", value: await history(ref) });
          return { status: machine.state === "canceled" ? "cancelled" : "failed" };
        }
        const messages = await readMessages(ref, signal);
        input.events.push({ op: "replace", path: "/messages", value: normalizeMessages(ref.machineId, messages) });
        const status = await ref.instances.request<{ status: string }>(
          ref.instanceId,
          `${machinePath(ref.machineId)}/agent/status`,
          { signal },
        );
        if (turnFinished(messages, baseline, status.status)) {
          input.events.push({
            op: "replace",
            path: "/messages",
            value: normalizeMessages(ref.machineId, await readMessages(ref, signal)),
          });
          return { status: "completed" };
        }
        await pause(signal);
      }
      return { status: "disconnected" };
    };
    const done = poll()
      .catch((error: unknown) => {
        if (signal.aborted) return { status: "disconnected" as const };
        ctx.logger.warn(`PocketCoder agent connection ended: ${String(error)}`);
        return { status: "disconnected" as const };
      })
      .then(async (exit) => {
        if (exit.status === "completed" || exit.status === "failed") await ctx.state.delete(cursorKey);
        return exit;
      });
    return { agentSessionId: ref.sessionId, done, stop, timeoutStrategy: "provider" } satisfies HarnessSession;
  };
  const send = async (ctx: HarnessContext, input: HarnessStartInput & { agentSessionId?: string }) => {
    const ref = target(ctx, input);
    if (input.attachments?.length)
      throw new Error("File attachments are not supported in this PocketCoder agent connection.");
    let machine = await ref.instances.request<Machine>(ref.instanceId, machinePath(ref.machineId), {
      signal: input.signal,
    });
    while (machine.state !== "ready" || machine.agent_state !== "stable") {
      if (isTerminal(machine)) throw new Error(`Machine is ${machine.state}. Launch a new machine to continue.`);
      const change = await ref.instances.request<{ workspace: Machine }>(
        ref.instanceId,
        `${machinePath(ref.machineId)}/changes?after=${machine.change_cursor}&wait=30`,
        { signal: input.signal },
      );
      machine = change.workspace;
    }
    const messages = await readMessages(ref, input.signal);
    if (!input.prompt.trim()) {
      input.events.push({ op: "replace", path: "/messages", value: normalizeMessages(ref.machineId, messages) });
      return {
        agentSessionId: ref.sessionId,
        done: Promise.resolve({ status: "completed" as const }),
        stop() {},
      } satisfies HarnessSession;
    }
    const baseline = messages.length;
    await ctx.state.set(`turn:${input.sessionId}`, { target: ref.sessionId, baseline });
    return attach(ctx, input, ref, baseline, input.prompt);
  };
  return defineHarness({
    id: "agent",
    label: "PocketCoder agent",
    cwdRequirement: "optional",
    capabilities: () => ["SessionReattach"],
    start: (ctx, input) => runs.run(ctx, input, (active) => send(ctx, active)),
    resume: (ctx, input) => runs.run(ctx, input, (active) => send(ctx, active)),
    reattach(ctx, input) {
      return runs.run(ctx, input, async (active) => {
        const ref = target(ctx, active);
        const cursor = await ctx.state.get<{ target: string; baseline: number }>(`turn:${active.sessionId}`);
        active.signal?.throwIfAborted();
        if (!cursor || cursor.target !== ref.sessionId) throw new Error("No pending PocketCoder turn was found.");
        return attach(ctx, active, ref, cursor.baseline);
      });
    },
    dispose: runs.dispose,
    async getMessages(ctx, input) {
      const ref = target(ctx, input);
      const machine = await ref.instances.request<Machine>(ref.instanceId, machinePath(ref.machineId));
      return isTerminal(machine) ? history(ref) : normalizeMessages(ref.machineId, await readMessages(ref));
    },
    recoverMessages: (_ctx, input) => reconcileMessageHistory(input),
  });
}
