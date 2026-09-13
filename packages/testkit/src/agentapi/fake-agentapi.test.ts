import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_BUSY_MESSAGE, type FakeAgentApi, startFakeAgentApi } from "./fake-agentapi";

let agent: FakeAgentApi | null = null;

afterEach(() => {
  agent?.stop();
  agent = null;
});

function send(target: FakeAgentApi, content: string) {
  return fetch(`${target.url}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user", content }),
  });
}

describe("fake AgentAPI", () => {
  // Upstream rejects a user message unless the agent is waiting for input. A
  // fake that always accepts one cannot catch a caller that sends too early.
  test("refuses a send while the agent is still starting up", async () => {
    agent = startFakeAgentApi({ status: "running" });

    const refused = await send(agent, "too early");

    expect(refused.status).toBe(500);
    expect(await refused.text()).toBe(AGENT_BUSY_MESSAGE);
    expect(agent.rejectedSends).toBe(1);
    expect(agent.messages).toHaveLength(0);
  });

  test("accepts the send once the agent reports itself waiting for input", async () => {
    agent = startFakeAgentApi({ status: "running" });
    agent.setStatus("stable");

    const accepted = await send(agent, "hello");

    expect(accepted.status).toBe(200);
    expect(agent.rejectedSends).toBe(0);
    expect(agent.messages.at(0)?.content).toBe("hello");
  });

  test("serves seeded transcript history", async () => {
    agent = startFakeAgentApi({
      messages: [{ id: 1, role: "user", content: "earlier", time: "2026-08-03T12:00:00Z" }],
    });

    const response = await fetch(`${agent.url}/messages`);

    expect(await response.json()).toEqual({
      messages: [{ id: 1, role: "user", content: "earlier", time: "2026-08-03T12:00:00Z" }],
    });
  });
});
