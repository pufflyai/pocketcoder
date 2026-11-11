import { randomUUID } from "node:crypto";
import { type managed, type PocketCoderClient, PocketCoderError } from "@pstdio/pocketcoder-sdk";
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
import { historyMessages, openMessages, readManagedMessages, renderMessages } from "./managed-sessions";

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
    const show = (value: Awaited<ReturnType<typeof renderMessages>>) =>
      input.events.push({ op: "replace", path: "/messages", value });
    const done = (async () => {
      // Resending the saved body is safe: the controller answers a known request ID with the original.
      // A refusal means it never accepted this body, so the saved request is dropped, not retried forever.
      const refused = await client.requests.submit(managedSessionId, pending.body, { signal: input.signal }).then(
        () => null,
        (error: unknown) =>
          error instanceof PocketCoderError && error.status < 500 && error.status !== 429
            ? error
            : Promise.reject(error),
      );
      if (refused) {
        await ctx.state.delete(pendingKey(input.sessionId));
        ctx.logger.warn(`PocketCoder refused the request: ${refused.message}`);
        return { status: "failed" as const };
      }
      // Committed history is read once per turn; only the live turn is polled.
      const committed = await historyMessages(client, managedSessionId, input.signal);
      while (!input.signal?.aborted) {
        const request = await client.requests.get(managedSessionId, pending.body.requestId, { signal: input.signal });
        if (request.state === "terminal") {
          show(renderMessages(await historyMessages(client, managedSessionId, input.signal), []));
          await ctx.state.delete(pendingKey(input.sessionId));
          return { status: statusOf(request.outcome) };
        }
        show(renderMessages(committed, await openMessages(client, managedSessionId, input.signal)));
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
      // The cancel ID stays in memory: saving it could bring back a request that already finished.
      async stop() {
        pending.cancelId ??= randomUUID();
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
