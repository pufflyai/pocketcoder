// A loopback fake of AgentAPI's three routes, used by tests that need a real
// agent service without a real coding agent. It mirrors the upstream guard that
// rejects a user message unless the agent is waiting for input, so a caller that
// sends too early fails here the same way it fails in production.

// The verbatim upstream rejection from coder/agentapi.
export const AGENT_BUSY_MESSAGE =
  "message can only be sent when the agent is waiting for user input";

export interface FakeAgentApiMessage {
  id: number;
  role: string;
  content: string;
  time: string;
}

export interface FakeAgentApiOptions {
  port?: number;
  // Start "running" to reproduce AgentAPI's startup window, where the service
  // answers health checks before the agent can accept a message.
  status?: "stable" | "running";
  messages?: FakeAgentApiMessage[];
}

export interface FakeAgentApi {
  url: string;
  port: number;
  messages: FakeAgentApiMessage[];
  // How many sends were refused because the agent was not waiting for input.
  readonly rejectedSends: number;
  setStatus(status: "stable" | "running"): void;
  stop(): void;
}

export function startFakeAgentApi(options: FakeAgentApiOptions = {}): FakeAgentApi {
  let status: "stable" | "running" = options.status ?? "stable";
  let rejectedSends = 0;
  const messages: FakeAgentApiMessage[] = [...(options.messages ?? [])];
  const nextId = () => messages.reduce((maximum, message) => Math.max(maximum, message.id), -1) + 1;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/status") {
        return Response.json({ status });
      }
      if (req.method === "GET" && url.pathname === "/messages") {
        return Response.json({ messages });
      }
      if (req.method === "POST" && url.pathname === "/message") {
        if (status !== "stable") {
          rejectedSends += 1;
          return new Response(AGENT_BUSY_MESSAGE, { status: 500 });
        }
        return req.json().then((body) => {
          const content = (body as { content?: string }).content ?? "";
          const time = new Date().toISOString();
          messages.push({ id: nextId(), role: "user", content, time });
          status = "running";
          queueMicrotask(() => {
            messages.push({ id: nextId(), role: "agent", content: `echo: ${content}`, time });
            status = "stable";
          });
          return Response.json({ ok: true });
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    port: Number(server.port),
    messages,
    get rejectedSends() {
      return rejectedSends;
    },
    setStatus(next) {
      status = next;
    },
    stop() {
      server.stop(true);
    },
  };
}
