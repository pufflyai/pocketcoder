import { expect, test } from "bun:test";
import type { ExecutionRecord, WorkloadCapability } from "@pstdio/pocketcoder-contracts";
import {
  EXECUTION_FAILURE_WAIT_MS,
  ExecutionDispatcher,
  ExecutionRefusedError,
  type ExecutionTransport,
} from "@pstdio/pocketcoder-runtime-core";
import { executionFixture } from "../workspaces/execution-fixture.test";
import { executionConversationIdentity, serviceExecutionTemplate } from "../workspaces/execution-service-fixture.test";

type Fixture = Awaited<ReturnType<typeof executionFixture>>;

const lookupCapabilities: WorkloadCapability[] = [
  "request-lookup",
  "deduplicated-accept",
  "targeted-cancel",
  "unknown-outcome",
];

function dispatcherFor(f: Fixture, transport: Partial<ExecutionTransport>, now: () => Date, health: boolean[]) {
  return new ExecutionDispatcher({
    store: f.store,
    now,
    inspect: async () => ({ exists: true, running: true, containerIdentity: f.runtime.incarnationId }),
    onHealth: (failed) => health.push(failed),
    transport: {
      connected: () => true,
      accept: async () => {},
      lookup: async () => undefined,
      cancel: async () => {},
      acknowledge: async () => {},
      ...transport,
    },
  });
}

async function run(dispatcher: ExecutionDispatcher, ticks: number, advance: () => void) {
  for (let tick = 0; tick < ticks; tick++) {
    await dispatcher.tick();
    await dispatcher.drain();
    advance();
  }
}

async function acceptRequest(f: Fixture, conversationId: ReturnType<typeof crypto.randomUUID>, at: Date) {
  const input = f.acceptance();
  const identity = executionConversationIdentity(input.execution.requestId, conversationId);
  await f.store.executions.accept(input, at, identity);
  return { input, identity };
}

test.each([
  { name: "with lookup", capabilities: lookupCapabilities },
  { name: "without lookup", capabilities: ["unknown-outcome"] as WorkloadCapability[] },
])(
  "a producer's refusal ($name) settles that request, is never resent, and its conversation continues",
  async ({ capabilities }) => {
    const f = await executionFixture(serviceExecutionTemplate, { capabilities });
    const health: boolean[] = [];
    let now = new Date();
    const calls = { accept: 0, released: [] as ExecutionRecord[] };
    try {
      const { input } = await acceptRequest(f, f.id, now);
      const dispatcher = dispatcherFor(
        f,
        {
          async accept() {
            calls.accept++;
            throw new ExecutionRefusedError(409, "busy");
          },
          lookup: async () => "absent",
          // Local finalization: the producer never accepted, so nothing is acknowledged remotely.
          async release(record) {
            calls.released.push(record);
            await f.store.executions.finalize(record.acceptance.execution, now);
          },
        },
        () => now,
        health,
      );
      await run(dispatcher, 30, () => {
        now = new Date(now.getTime() + 10_000);
      });

      expect(calls.accept).toBe(1);
      expect(calls.released).toHaveLength(1);
      const settled = await f.store.executions.get(input.execution);
      expect(settled).toMatchObject({ phase: "terminal", outcome: { refused: { status: 409, message: "busy" } } });
      expect(settled?.acknowledgedAt).not.toBeNull();
      expect(health).not.toContain(true);
      const next = f.acceptance();
      const accepted = await f.store.executions.accept(
        next,
        now,
        executionConversationIdentity(next.execution.requestId, f.id),
      );
      expect(accepted.kind).toBe("accepted");
    } finally {
      await f.dispose();
    }
  },
);

test("a request whose outcome stays unknown is retried with backoff and never fails readiness on its own", async () => {
  const f = await executionFixture(serviceExecutionTemplate, { capabilities: lookupCapabilities });
  const health: boolean[] = [];
  let now = new Date();
  let attempts = 0;
  try {
    await acceptRequest(f, f.id, now);
    const unsettled = async (): Promise<undefined> => {
      attempts++;
      throw new Error("Execution response is unsettled; reconcile the same producer ID.");
    };
    const dispatcher = dispatcherFor(f, { accept: unsettled, lookup: unsettled }, () => now, health);
    // Ten minutes of one-second ticks.
    await run(dispatcher, 600, () => {
      now = new Date(now.getTime() + 1_000);
    });

    expect(attempts).toBeGreaterThan(3);
    expect(attempts).toBeLessThan(20);
    expect(health).not.toContain(true);
  } finally {
    await f.dispose();
  }
});

test("requests failing in several workspaces past the bound fail readiness", async () => {
  const first = await executionFixture(serviceExecutionTemplate, { capabilities: lookupCapabilities });
  const second = await executionFixture(serviceExecutionTemplate, { capabilities: lookupCapabilities, base: first });
  const health: boolean[] = [];
  let now = new Date();
  try {
    await acceptRequest(first, first.id, now);
    await acceptRequest(second, second.id, now);
    const relayDown = async (): Promise<undefined> => {
      throw new Error("relay unreachable");
    };
    const dispatcher = dispatcherFor(first, { accept: relayDown, lookup: relayDown }, () => now, health);
    await run(dispatcher, 3, () => {
      now = new Date(now.getTime() + 1_000);
    });
    expect(health).not.toContain(true);

    now = new Date(now.getTime() + EXECUTION_FAILURE_WAIT_MS);
    await run(dispatcher, 400, () => {
      now = new Date(now.getTime() + 1_000);
    });
    expect(health.at(-1)).toBe(true);
  } finally {
    await first.dispose();
  }
});
