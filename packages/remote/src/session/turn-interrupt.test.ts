import { describe, expect, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import { captureTurnAttachmentBatch } from "../attachments/attachments";
import { ControlPlaneClient } from "../client/control-plane";
import { relayTarget, type SessionTarget } from "./session-target";
import { executeRemoteTurn } from "./turn";

const A = "11111111-1111-4111-8111-111111111111";

interface AgentOptions {
  // The agent is already busy with another client's turn.
  busy?: boolean;
  // The prompt reaches the agent 50 ms after the request starts, even when
  // the caller gives up on the request, as the server's relay does.
  slowSubmit?: boolean;
  interruptError?: { status: number; code: string };
  // The interrupt answers only once this resolves.
  interruptGate?: Promise<void>;
}

function errorResponse(status: number, code: string) {
  return Response.json({ error: { code, message: code, request_id: "request" } }, { status });
}

// A remote agent whose turn never finishes on its own. Like the server, the
// interrupt only stops a turn that is running when it arrives.
function remoteAgent(options: AgentOptions = {}) {
  const requests: string[] = [];
  let running = options.busy ?? false;
  let sending!: () => void;
  const promptSending = new Promise<void>((resolve) => {
    sending = resolve;
  });
  let landing!: () => void;
  const promptLanded = new Promise<void>((resolve) => {
    landing = resolve;
  });
  // Like fetch, an abort rejects the caller's request at once.
  const submit = (signal: AbortSignal | null | undefined) => {
    sending();
    const landed = (options.slowSubmit ? Bun.sleep(50) : Promise.resolve()).then(() => {
      running = true;
      landing();
      return Response.json({ ok: true });
    });
    const aborted = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    return Promise.race([landed, aborted]);
  };
  const interrupt = async () => {
    await options.interruptGate;
    if (options.interruptError) return errorResponse(options.interruptError.status, options.interruptError.code);
    const status = running ? "requested" : "idle";
    running = false;
    return Response.json({ status });
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/messages")) return Response.json({ messages: [] });
    if (path.endsWith("/status")) return Response.json({ status: running ? "running" : "stable" });
    if (request.method === "POST" && path.endsWith("/message")) return await submit(init?.signal);
    if (request.method === "POST" && path.endsWith("/interrupt")) return await interrupt();
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  const controlPlane = new ControlPlaneClient({ baseUrl: "http://pocketcoder.test", key: "key" }, fetchImpl);
  return { fetchImpl, controlPlane, requests, promptSending, promptLanded, isRunning: () => running };
}

function context(): Context {
  return { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
}

function startTurn(
  agent: ReturnType<typeof remoteAgent>,
  options: { target?: SessionTarget; interruptOnAbort?: () => boolean } = {},
) {
  const controller = new AbortController();
  const settled = executeRemoteTurn({
    target: options.target ?? relayTarget("http://pocketcoder.test", "key", A),
    controlPlane: agent.controlPlane,
    attachmentBatch: captureTurnAttachmentBatch(context(), []),
    prompt: "hello",
    signal: controller.signal,
    interruptOnAbort: options.interruptOnAbort ?? (() => true),
    fetch: agent.fetchImpl,
  }).then(
    () => {
      throw new Error("expected the turn to abort");
    },
    (error: unknown) => error,
  );
  return { abort: () => controller.abort(), settled };
}

async function abortedTurn(
  agent: ReturnType<typeof remoteAgent>,
  abortWhen: Promise<unknown>,
  options: Parameters<typeof startTurn>[1] = {},
) {
  const turn = startTurn(agent, options);
  await abortWhen;
  turn.abort();
  return await turn.settled;
}

const interrupts = (requests: string[]) => requests.filter((request) => request.endsWith("/agent/interrupt"));

describe("remote turn interruption", () => {
  test("stops the remote turn when the user aborts after sending", async () => {
    const agent = remoteAgent();

    const error = await abortedTurn(
      agent,
      agent.promptSending.then(() => Bun.sleep(20)),
    );

    expect(error).toMatchObject({ name: "AbortError" });
    expect(interrupts(agent.requests)).toEqual([`POST /v1/workspaces/${A}/agent/interrupt`]);
  });

  test("stops the remote turn when the abort lands while the prompt is being sent", async () => {
    const agent = remoteAgent({ slowSubmit: true });

    await abortedTurn(agent, agent.promptSending);
    await agent.promptLanded;

    expect(interrupts(agent.requests)).toHaveLength(1);
    expect(agent.isRunning()).toBe(false);
  });

  test("ends the aborted reply only after the interrupt answers", async () => {
    let release!: () => void;
    const agent = remoteAgent({ interruptGate: new Promise((resolve) => (release = resolve)) });
    const turn = startTurn(agent);
    await agent.promptSending.then(() => Bun.sleep(20));
    turn.abort();

    const early = await Promise.race([turn.settled.then(() => "settled"), Bun.sleep(50).then(() => "waiting")]);
    release();

    expect(early).toBe("waiting");
    await turn.settled;
    expect(agent.isRunning()).toBe(false);
  });

  test("says the remote turn may still run when the interrupt fails", async () => {
    const agent = remoteAgent({ interruptError: { status: 502, code: "relay.upstream_error" } });

    const error = await abortedTurn(
      agent,
      agent.promptSending.then(() => Bun.sleep(20)),
    );

    expect(String(error)).toContain("stopped locally; the remote turn may still be running");
    expect(agent.isRunning()).toBe(true);
  });

  test("leaves another client's turn alone when aborted before sending", async () => {
    const agent = remoteAgent({ busy: true });

    await abortedTurn(agent, Bun.sleep(50));

    expect(agent.requests).not.toContain(`POST /v1/workspaces/${A}/agent/message`);
    expect(interrupts(agent.requests)).toEqual([]);
  });

  test("leaves the remote turn running when the caller declines to interrupt", async () => {
    const agent = remoteAgent();

    await abortedTurn(
      agent,
      agent.promptSending.then(() => Bun.sleep(20)),
      { interruptOnAbort: () => false },
    );

    expect(interrupts(agent.requests)).toEqual([]);
  });

  test("keeps the abort when the template cannot interrupt", async () => {
    const agent = remoteAgent({ interruptError: { status: 409, code: "agent.interrupt_unsupported" } });

    const error = await abortedTurn(
      agent,
      agent.promptSending.then(() => Bun.sleep(20)),
    );

    expect(error).toMatchObject({ name: "AbortError" });
    expect(interrupts(agent.requests)).toHaveLength(1);
  });

  test("does not interrupt a direct AgentAPI target", async () => {
    const agent = remoteAgent();

    await abortedTurn(
      agent,
      agent.promptSending.then(() => Bun.sleep(20)),
      {
        target: { mode: "direct", key: "key", serviceUrl: "http://agent.test" },
      },
    );

    expect(interrupts(agent.requests)).toEqual([]);
  });
});
