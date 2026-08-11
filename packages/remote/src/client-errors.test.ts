import { describe, expect, test } from "bun:test";
import { RemoteAgentClient } from "./client";
import { RemoteRequestError, type RemoteRequestPhase } from "./remote-request-error";

const RELAY = "http://pocketcoder.test/v1/workspaces/ws/agent";
const DIRECT = "http://agentapi.test";

function terminalResponse(
  body: unknown = {
    error: {
      code: "workspace.terminal",
      message: "raw server detail must stay private",
      request_id: "request-secret",
    },
  },
) {
  return Response.json(body, { status: 410 });
}

function requestOf(input: string | URL | Request, init?: RequestInit) {
  return input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
}

async function expectRemoteError(
  result: Promise<unknown>,
  expected: {
    phase: RemoteRequestPhase;
    promptAccepted: boolean;
    code?: string;
    status?: number;
  },
) {
  try {
    await result;
    throw new Error("expected request to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteRequestError);
    expect(error).toMatchObject(expected);
    expect((error as Error).message).not.toContain("raw server detail");
    expect((error as Error).message).not.toContain("request-secret");
  }
}

function postAcceptanceFailureFetch(failedPath: "/messages" | "/status") {
  let submitted = false;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = requestOf(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/messages")) {
      if (submitted && failedPath === "/messages") return terminalResponse();
      return Response.json({ messages: [] });
    }
    if (path.endsWith("/events")) return new Response(null, { status: 404 });
    if (request.method === "POST") {
      submitted = true;
      return Response.json({ ok: true });
    }
    if (path.endsWith("/status")) {
      return failedPath === "/status" ? terminalResponse() : Response.json({ status: "stable" });
    }
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
}

describe("RemoteAgentClient request errors", () => {
  test("records a validated terminal envelope at initial message lookup", async () => {
    const client = new RemoteAgentClient(
      { serviceUrl: RELAY, key: "key", timeoutMs: 100 },
      (async () => terminalResponse()) as unknown as typeof fetch,
    );

    await expectRemoteError(client.send("hello"), {
      phase: "initial_messages",
      promptAccepted: false,
      status: 410,
      code: "workspace.terminal",
    });
  });

  test("records failures during baseline changes and initial event setup", async () => {
    for (const failedPath of ["/changes", "/events"] as const) {
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const request = requestOf(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/messages")) return Response.json({ messages: [] });
        if (path.endsWith(failedPath)) return terminalResponse();
        if (path.endsWith("/changes")) {
          return Response.json({ cursor: 0, workspace: { agent_state: "stable" } });
        }
        return new Response("missing", { status: 404 });
      }) as typeof fetch;
      const client = new RemoteAgentClient({ serviceUrl: RELAY, key: "key" }, fetchImpl);

      await expectRemoteError(client.send("hello"), {
        phase: failedPath === "/changes" ? "baseline_changes" : "initial_events",
        promptAccepted: false,
        status: 410,
        code: "workspace.terminal",
      });
    }
  });

  test("marks a terminal submit gate as not accepted", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestOf(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) return Response.json({ messages: [] });
      if (path.endsWith("/events")) return new Response(null, { status: 404 });
      if (request.method === "POST") return terminalResponse();
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient({ serviceUrl: DIRECT, key: "key" }, fetchImpl);

    await expectRemoteError(client.send("hello"), {
      phase: "submit",
      promptAccepted: false,
      status: 410,
      code: "workspace.terminal",
    });
  });

  test("marks final message and reply status failures as accepted", async () => {
    for (const failedPath of ["/messages", "/status"] as const) {
      const client = new RemoteAgentClient(
        { serviceUrl: DIRECT, key: "key" },
        postAcceptanceFailureFetch(failedPath),
      );

      await expectRemoteError(client.send("hello"), {
        phase: failedPath === "/messages" ? "reply_messages" : "reply_status",
        promptAccepted: true,
        status: 410,
        code: "workspace.terminal",
      });
    }
  });

  test("does not swallow a terminal event reconnect after prompt acceptance", async () => {
    let eventRequests = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestOf(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) return Response.json({ messages: [] });
      if (path.endsWith("/changes")) {
        return Response.json({ cursor: 0, workspace: { agent_state: "running" } });
      }
      if (path.endsWith("/events")) {
        eventRequests += 1;
        return eventRequests === 1
          ? new Response(new ReadableStream({ start: (controller) => controller.close() }))
          : terminalResponse();
      }
      if (request.method === "POST") return Response.json({ ok: true });
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      { serviceUrl: RELAY, key: "key", pollIntervalMs: 1, timeoutMs: 100 },
      fetchImpl,
    );

    await expectRemoteError(client.send("hello"), {
      phase: "reply_events",
      promptAccepted: true,
      status: 410,
      code: "workspace.terminal",
    });
  });

  test("does not reconnect the event stream while POST is ambiguous", async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let eventRequests = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestOf(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) return Response.json({ messages: [] });
      if (path.endsWith("/changes")) {
        return Response.json({ cursor: 0, workspace: { agent_state: "running" } });
      }
      if (path.endsWith("/events")) {
        eventRequests += 1;
        return eventRequests === 1
          ? new Response(new ReadableStream({ start: (controller) => controller.close() }))
          : terminalResponse();
      }
      if (request.method === "POST") {
        await postGate;
        return Response.json({ ok: true });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      { serviceUrl: RELAY, key: "key", pollIntervalMs: 1, timeoutMs: 100 },
      fetchImpl,
    );
    const result = client.send("hello");
    await Bun.sleep(5);
    expect(eventRequests).toBe(1);

    releasePost();
    await expectRemoteError(result, {
      phase: "reply_events",
      promptAccepted: true,
      status: 410,
      code: "workspace.terminal",
    });
  });
});

describe("RemoteAgentClient error validation and cancellation", () => {
  test("never validates malformed, oversized, or foreign 410 bodies", async () => {
    const bodies = [
      new Response("not-json", { status: 410 }),
      new Response("x".repeat(70_000), { status: 410 }),
      terminalResponse({ error: { code: "not.pocketcoder", message: "x", request_id: "r" } }),
    ];
    for (const response of bodies) {
      const client = new RemoteAgentClient({ serviceUrl: DIRECT, key: "key" }, (async () =>
        response.clone()) as unknown as typeof fetch);
      await expectRemoteError(client.send("hello"), {
        phase: "initial_messages",
        promptAccepted: false,
        status: 410,
        code: undefined,
      });
    }
  });

  test("reports prompt acceptance only after POST succeeds", async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let eventsController!: ReadableStreamDefaultController<Uint8Array>;
    let postResolved = false;
    let finalReads = 0;
    const encoder = new TextEncoder();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestOf(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) {
        finalReads += postResolved ? 1 : 0;
        return Response.json({
          messages: postResolved ? [{ id: 1, role: "agent", content: "new reply" }] : [],
        });
      }
      if (path.endsWith("/changes")) {
        return Response.json({ cursor: 0, workspace: { agent_state: "stable" } });
      }
      if (path.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => (eventsController = controller),
          }),
        );
      }
      if (request.method === "POST") {
        eventsController.enqueue(
          encoder.encode('event: status_change\ndata: {"agent_type":"pi","status":"stable"}\n\n'),
        );
        await postGate;
        postResolved = true;
        queueMicrotask(() =>
          eventsController.enqueue(
            encoder.encode('event: status_change\ndata: {"agent_type":"pi","status":"stable"}\n\n'),
          ),
        );
        return Response.json({ ok: true });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient(
      { serviceUrl: RELAY, key: "key", timeoutMs: 100 },
      fetchImpl,
    );

    const result = client.send("hello");
    await Bun.sleep(0);
    expect(finalReads).toBe(0);
    releasePost();
    await expect(result).resolves.toBe("new reply");
    expect(finalReads).toBe(1);
  });

  test("calls the acceptance hook once and preserves abort and timeout errors", async () => {
    let accepted = 0;
    let submitted = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = requestOf(input, init);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) {
        return Response.json({
          messages: submitted ? [{ id: 1, role: "agent", content: "ok" }] : [],
        });
      }
      if (path.endsWith("/events")) return new Response(null, { status: 404 });
      if (path.endsWith("/status")) return Response.json({ status: "stable" });
      if (request.method === "POST") {
        submitted = true;
        return Response.json({ ok: true });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const client = new RemoteAgentClient({ serviceUrl: DIRECT, key: "key" }, fetchImpl);
    await client.send("hello", undefined, [], undefined, () => {
      accepted += 1;
    });
    expect(accepted).toBe(1);

    const hangingFetch = (async (_input: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }),
      )) as typeof fetch;
    const controller = new AbortController();
    const aborted = new RemoteAgentClient({ serviceUrl: DIRECT, key: "key" }, hangingFetch).send(
      "hello",
      controller.signal,
    );
    controller.abort(new Error("caller canceled"));
    await expect(aborted).rejects.toThrow("caller canceled");

    const timedOut = new RemoteAgentClient(
      { serviceUrl: DIRECT, key: "key", timeoutMs: 1 },
      hangingFetch,
    ).send("hello");
    await expect(timedOut).rejects.toThrow("remote agent did not finish within 1ms");
  });
});
