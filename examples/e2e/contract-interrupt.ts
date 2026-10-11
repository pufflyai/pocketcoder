import { errorBody, readBody } from "./contract-messages";
import { waitFor } from "./local-process";

type Request = (path: string, init?: RequestInit) => Promise<Response>;

async function agentStatus(request: Request, agent: string): Promise<unknown> {
  const response = await request(`${agent}/status`);
  const body = (await readBody(response)) as { status?: unknown };
  if (!response.ok) throw new Error(`status relay failed (${response.status}): ${errorBody(body)}`);
  return body.status;
}

async function interrupt(request: Request, agent: string): Promise<unknown> {
  const response = await request(`${agent}/interrupt`, { method: "POST" });
  const body = (await readBody(response)) as { status?: unknown };
  if (!response.ok) throw new Error(`interrupt failed (${response.status}): ${errorBody(body)}`);
  return body.status;
}

// Starts a turn that only ends when interrupted, proves that closing an event
// stream leaves it running, then interrupts it and waits for the agent to
// accept input again. The caller sends its follow-up in the same workspace.
export async function proveTurnInterrupt(
  request: Request,
  workspaceId: string,
  prompt: string,
  settleTimeoutMs: number,
): Promise<{ settledInMs: number }> {
  const agent = `/v1/workspaces/${workspaceId}/agent`;
  const observer = new AbortController();
  const events = await request(`${agent}/events`, {
    headers: { accept: "text/event-stream" },
    signal: observer.signal,
  });
  if (!events.ok) throw new Error(`event stream failed (${events.status})`);
  const sent = await request(`${agent}/message`, {
    method: "POST",
    body: JSON.stringify({ type: "user", content: prompt }),
  });
  if (!sent.ok) throw new Error(`message relay failed (${sent.status}): ${errorBody(await readBody(sent))}`);
  await waitFor(async () => (await agentStatus(request, agent)) === "running", 60_000, "the turn to start");

  observer.abort("observer disconnected");
  await Bun.sleep(2_000);
  if ((await agentStatus(request, agent)) !== "running") {
    throw new Error("closing the event stream stopped the turn");
  }

  const startedAt = Date.now();
  const requested = await interrupt(request, agent);
  if (requested !== "requested") throw new Error(`expected a requested interrupt, got ${JSON.stringify(requested)}`);
  await waitFor(
    async () => (await agentStatus(request, agent)) === "stable",
    settleTimeoutMs,
    "the interrupted turn to settle",
  );
  const settledInMs = Date.now() - startedAt;

  const repeated = await interrupt(request, agent);
  if (repeated !== "idle") throw new Error(`expected an idle interrupt, got ${JSON.stringify(repeated)}`);
  return { settledInMs };
}
