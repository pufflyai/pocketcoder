import { afterEach, expect, test } from "bun:test";
import { type ConversationMessageInput, ExecSpecSchema } from "@pstdio/pocketcoder-contracts";
import { AgentHealthMonitor } from "./agent-health";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function message(id: number, role: "user" | "agent", content: string) {
  return { id, role, content, time: "2026-10-05T12:00:00Z" };
}

function fixture(fetch: (request: Request) => Response | Promise<Response>) {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    fetch(
      input instanceof Request ? new Request(input, init) : new Request(String(input), init),
    )) as typeof globalThis.fetch;
  const exec = ExecSpecSchema.parse({
    agentapi_native: true,
    setup: [],
    harness: { command: ["unused"], env: {} },
    env: {},
    services: {
      agent: {
        baseUrl: "http://agent.test",
        healthPath: "/status",
        required: true,
        routes: [{ method: "GET", path: "/messages" }],
      },
    },
    timeouts: { start: "2s", maxAge: "1h", idle: "1h", disconnectGrace: "2s", terminateGrace: "2s" },
    persistence: { mounts: [], conversation_restore: "filesystem_only" },
    checkpoint_hook: null,
    outputs: {},
  });
  const contents: string[] = [];
  const logs: string[] = [];
  let connected = true;
  const monitor = new AgentHealthMonitor(
    {
      exec: () => exec,
      childPhase: () => "running",
      send: (type, payload) => {
        if (type === "conversation_message") {
          if (!connected) return false;
          contents.push((payload as { content: string }).content);
        }
        return true;
      },
      log: (line) => logs.push(line),
    },
    fetchImpl,
  );
  return {
    monitor,
    contents,
    logs,
    exec,
    disconnect: () => {
      connected = false;
    },
    reconnect: () => {
      connected = true;
    },
  };
}

test.each(["running", "stable"] as const)(
  "captures accepted input once while %s without freezing the tail",
  async (state) => {
    let tail = "partial";
    const { monitor, contents } = fixture(() =>
      Response.json({
        messages: [
          message(1, "user", "earlier"),
          message(2, "agent", "completed"),
          message(3, "user", "latest Åäö — 東京"),
          message(4, "agent", tail),
        ],
      }),
    );
    monitor.setAgentState(state);
    await monitor.syncMessages();
    await monitor.syncMessages();
    const expected = ["earlier", "completed", "latest Åäö — 東京"];
    if (state === "stable") expected.push("partial");
    expect(contents).toEqual(expected);
    if (state === "running") {
      tail = "complete";
      monitor.setAgentState("stable");
      await monitor.syncMessages();
      expect(contents).toEqual([...expected, "complete"]);
    }
  },
);

test("health probes capture accepted input even while AgentAPI is running", async () => {
  const { monitor, contents, exec } = fixture((request) => {
    if (new URL(request.url).pathname === "/status") return Response.json({ status: "running" });
    return Response.json({ messages: [message(1, "user", "accepted")] });
  });
  await monitor.probeService(exec, "agent", true);
  await monitor.syncMessages();
  expect(contents).toEqual(["accepted"]);
});

test("a fresh final sync waits for an older read and then reads newer input", async () => {
  const started = deferred();
  const released = deferred();
  cleanup.push(released.release);
  const messages = [message(1, "user", "earlier")];
  let reads = 0;
  const { monitor, contents } = fixture(async () => {
    const snapshot = [...messages];
    if (++reads === 1) {
      started.release();
      await released.promise;
    }
    return Response.json({ messages: snapshot });
  });
  monitor.setAgentState("stable");
  const periodic = monitor.syncMessages();
  await started.promise;
  messages.push(message(2, "user", "accepted before Stop"));
  const final = monitor.syncMessages({ fresh: true });
  released.release();
  await Promise.all([periodic, final]);
  expect(reads).toBe(2);
  expect(contents).toEqual(["earlier", "accepted before Stop"]);
});

test.each([false, true])(
  "a health transition during a read cannot freeze a partial reply (stable again: %s)",
  async (stableAgain) => {
    const started = deferred();
    const released = deferred();
    cleanup.push(released.release);
    let reads = 0;
    const { monitor, contents } = fixture(async () => {
      const tail = ++reads === 1 ? "partial" : "complete";
      if (reads === 1) {
        started.release();
        await released.promise;
      }
      return Response.json({ messages: [message(1, "user", "prompt"), message(2, "agent", tail)] });
    });
    monitor.setAgentState("stable");
    const reading = monitor.syncMessages();
    await started.promise;
    monitor.setAgentState("running");
    if (stableAgain) monitor.setAgentState("stable");
    released.release();
    await reading;
    monitor.setAgentState("stable");
    await monitor.syncMessages();
    expect(contents).toEqual(["prompt", "complete"]);
  },
);

test("failed forwarding leaves accepted input available for retry", async () => {
  const { monitor, contents, disconnect, reconnect } = fixture(() =>
    Response.json({ messages: [message(1, "user", "accepted")] }),
  );
  monitor.setAgentState("stable");
  disconnect();
  await monitor.syncMessages().catch(() => {});
  reconnect();
  await monitor.syncMessages();
  expect(contents).toEqual(["accepted"]);
});

test("final sync deadline includes waiting for an older read", async () => {
  const started = deferred();
  const released = deferred();
  cleanup.push(released.release);
  const { monitor } = fixture(async () => {
    started.release();
    await released.promise;
    return Response.json({ messages: [] });
  });
  monitor.setAgentState("stable");
  const periodic = monitor.syncMessages();
  await started.promise;
  const controller = new AbortController();
  const final = monitor.syncMessages({ fresh: true, signal: controller.signal });
  controller.abort(new Error("shutdown deadline"));
  released.release();
  await expect(final).rejects.toThrow("shutdown deadline");
  await periodic;
});

// Supervisor wiring: explicit history facts cannot pass through the legacy
// numeric-ID/stable-tail filter during checkpoint or periodic synchronization.
test.each(["running", "stable"] as const)("forwards identified facts and revisions once while %s", async (state) => {
  const identity = {
    schema: "pocketcoder.conversation/v2" as const,
    authority: "external" as const,
    conversation_id: "10000000-0000-4000-8000-000000000001",
    request_id: "10000000-0000-4000-8000-000000000002",
    turn_id: "10000000-0000-4000-8000-000000000003",
    request_fingerprint: "a".repeat(64),
  };
  const messages: ConversationMessageInput[] = [
    { type: "intermediate" },
    { type: "final_response" },
    { type: "turn_terminal", outcome: "interrupted" },
  ].map((fact, index) => ({
    message_id: `event-${index + 1}:1`,
    role: "assistant",
    content: `fact-${index + 1}`,
    occurred_at: "2026-10-13T12:00:00Z",
    metadata: {},
    identity: {
      ...identity,
      event_id: `10000000-0000-4000-8000-${String(index + 4).padStart(12, "0")}`,
      message_id: "answer",
      sequence: index + 1,
      revision: 1,
      fact: fact as NonNullable<ConversationMessageInput["identity"]>["fact"],
    },
  }));
  const { monitor, contents } = fixture(() => Response.json({ messages }));
  monitor.setAgentState(state);
  await monitor.syncMessages();
  await monitor.syncMessages();
  expect(contents).toEqual(["fact-1", "fact-2", "fact-3"]);
  const original = messages[1];
  if (!original?.identity) throw new Error("identity missing");
  messages.push({ ...original, content: "updated final", identity: { ...original.identity, revision: 2 } });
  await monitor.syncMessages();
  expect(contents).toEqual(["fact-1", "fact-2", "fact-3", "updated final"]);
});
