import { randomUUID } from "node:crypto";
import type { managed, PocketCoderClient } from "@pstdio/pocketcoder-sdk";
import {
  defineHarness,
  type HarnessContext,
  type HarnessSession,
  type HarnessStartInput,
  reconcileMessageHistory,
} from "@pstdio/sdk/extensions";
import { createHarnessRuns } from "./harness-runs";
import { instancesFor } from "./instances";
import { managedBindings } from "./managed-bindings";
import { readManagedMessages } from "./managed-sessions";

type Pending = { body: managed.RequestInput; cancelId?: string };
type Target = { client: PocketCoderClient; instanceId: string; managedSessionId: string };
const pendingKey = (sessionId: string) => `managed-request:${sessionId}`;

// A chat on one managed session. The controller chooses and replaces its machine; the chat only
// keeps the session ID and the exact body of its unfinished request.
export function createManagedHarness(getInstances = instancesFor, getBindings = managedBindings) {
  const runs = createHarnessRuns();
  // The agent session ID is `<instance>:<managed session>`, so history reads need no chat binding.
  const target = async (ctx: HarnessContext, input: { sessionId?: string; agentSessionId?: string }) => {
    if (!ctx.projectId) throw new Error("Choose a PocketCoder project.");
    const instances = getInstances(ctx.projectId);
    const [instanceId, managedSessionId] = input.agentSessionId?.split(":") ?? [];
    const ref =
      instanceId && managedSessionId
        ? { instanceId, managedSessionId }
        : await getBindings(ctx.projectId).target(input.sessionId ?? "");
    return { ...ref, client: await instances.client(ref.instanceId) };
  };

  function observe(ctx: HarnessContext, input: HarnessStartInput, ref: Target, pending: Pending): HarnessSession {
    const { client, managedSessionId } = ref;
    const agentSessionId = `${ref.instanceId}:${managedSessionId}`;
    const done = (async () => {
      // Resending the saved body is safe: the controller answers a known request ID with the original.
      await client.requests.submit(managedSessionId, pending.body, { signal: input.signal });
      while (!input.signal?.aborted) {
        const request = await client.requests.get(managedSessionId, pending.body.requestId, { signal: input.signal });
        input.events.push({
          op: "replace",
          path: "/messages",
          value: await readManagedMessages(client, managedSessionId, input.signal),
        });
        if (request.state === "terminal") {
          await ctx.state.delete(pendingKey(input.sessionId));
          return { status: statusOf(request.outcome) };
        }
        await Bun.sleep(250);
      }
      return { status: "disconnected" as const };
    })().catch((error: unknown) => {
      if (!input.signal?.aborted) ctx.logger.warn(`PocketCoder managed request ended: ${String(error)}`);
      return { status: "disconnected" as const };
    });
    return {
      agentSessionId,
      timeoutStrategy: "provider",
      async stop() {
        pending.cancelId ??= randomUUID();
        await ctx.state.set(pendingKey(input.sessionId), pending);
        await client.requests.cancel(managedSessionId, pending.body.requestId, { cancelId: pending.cancelId });
      },
      done,
    };
  }

  async function start(ctx: HarnessContext, input: HarnessStartInput): Promise<HarnessSession> {
    const ref = await target(ctx, input);
    const saved = await ctx.state.get<Pending>(pendingKey(input.sessionId));
    if (saved) return observe(ctx, input, ref, saved);
    if (!input.prompt.trim()) {
      input.events.push({
        op: "replace",
        path: "/messages",
        value: await readManagedMessages(ref.client, ref.managedSessionId, input.signal),
      });
      return {
        agentSessionId: `${ref.instanceId}:${ref.managedSessionId}`,
        done: Promise.resolve({ status: "completed" }),
        stop() {},
      };
    }
    const pending: Pending = {
      body: {
        requestId: randomUUID(),
        message: input.prompt,
        attachments: [],
        dispatchDeadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
    // Saved before sending, so a lost reply is resent unchanged instead of run twice.
    await ctx.state.set(pendingKey(input.sessionId), pending);
    return observe(ctx, input, ref, pending);
  }

  return defineHarness({
    id: "managed",
    label: "PocketCoder managed session",
    cwdRequirement: "optional",
    capabilities: () => ["SessionReattach"],
    start: (ctx, input) => runs.run(ctx, input, (active) => start(ctx, active)),
    resume: (ctx, input) => runs.run(ctx, input, (active) => start(ctx, active)),
    reattach: (ctx, input) =>
      runs.run(ctx, input, async (active) => {
        const saved = await ctx.state.get<Pending>(pendingKey(active.sessionId));
        if (!saved) throw new Error("No pending PocketCoder request was found.");
        return observe(ctx, { ...active, prompt: "" }, await target(ctx, active), saved);
      }),
    dispose: runs.dispose,
    async getMessages(ctx, input) {
      const ref = await target(ctx, input);
      return readManagedMessages(ref.client, ref.managedSessionId);
    },
    recoverMessages: (_ctx, input) => reconcileMessageHistory(input),
  });
}

function statusOf(outcome: managed.Request["outcome"]) {
  if (outcome === "completed") return "completed" as const;
  if (outcome === "canceled" || outcome === "interrupted") return "cancelled" as const;
  return "failed" as const;
}
