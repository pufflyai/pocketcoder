import { expect, test } from "bun:test";
import { gatewayFixture, PROVIDER_KEY, textRequest, WORKSPACE_BEARER } from "./gateway-fixture.test";
import { until } from "./provider-fixture.test";

test("concurrent calls compete for one allowance and denied calls never reach generation", async () => {
  const g = await gatewayFixture({ inputTokens: 40, outputTokens: 10 });
  try {
    g.provider.setMode("hold");
    const calls = Array.from({ length: 4 }, () => g.call(textRequest()));
    await until(() => g.provider.heldCount() === 2);
    g.provider.release();
    const statuses = (await Promise.all(calls)).map((reply) => reply.status).sort();
    expect(statuses).toEqual([200, 200, 429, 429]);
    expect(g.provider.generations()).toHaveLength(2);
    expect(await g.usage()).toMatchObject({
      settledInputTokens: 80,
      settledOutputTokens: 20,
      heldInputTokens: 0,
      inFlightModelRequests: 0,
    });
    g.provider.setMode("complete");
    const late = await g.call(textRequest());
    expect(late.status).toBe(429);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe("budget.exhausted");
    expect(g.provider.generations()).toHaveLength(2);
    expect(g.denied).toHaveLength(3);
    expect(g.denied[0]).toEqual(g.grant.identity);
  } finally {
    await g.dispose();
  }
});

test.each([
  ["an unknown model", { model: "other/model" }, 403],
  ["a caller-supplied budget scope", { budgetScopeIds: ["00000000-0000-4000-8000-000000000000"] }, 422],
  ["caller-supplied usage", { usage: { input_tokens: 0, output_tokens: 0 } }, 422],
  ["a provider-side conversation", { previous_response_id: "resp_old" }, 422],
  ["background mode", { background: true }, 422],
  ["provider storage", { store: true }, 422],
  [
    "an image input",
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://x/y.png" }] }] },
    422,
  ],
  ["a provider-hosted tool", { tools: [{ type: "web_search" }] }, 422],
  ["an output cap below the model minimum", { max_output_tokens: 3 }, 422],
  ["an upstream URL override", { upstreamUrl: "https://elsewhere.example" }, 422],
])("rejects %s before counting or reserving", async (_name, extra, status) => {
  const g = await gatewayFixture();
  try {
    const reply = await g.call(textRequest(extra));
    expect(reply.status).toBe(status);
    expect(g.provider.journal).toHaveLength(0);
    expect(await g.invocations()).toHaveLength(0);
  } finally {
    await g.dispose();
  }
});

test("a missing or substituted workspace credential is refused", async () => {
  const g = await gatewayFixture();
  try {
    const anonymous = await g.call(textRequest(), { headers: { "content-type": "application/json" } });
    expect(anonymous.status).toBe(401);
    const forged = await g.call(textRequest(), {
      headers: { authorization: "Bearer someone-else", "content-type": "application/json" },
    });
    expect(forged.status).toBe(401);
    expect(g.provider.journal).toHaveLength(0);
  } finally {
    await g.dispose();
  }
});

test("a missing provider count fails closed without a reservation", async () => {
  const g = await gatewayFixture();
  try {
    g.provider.setMode("no-count");
    const reply = await g.call(textRequest());
    expect(reply.status).toBe(502);
    expect(g.provider.generations()).toHaveLength(0);
    expect(await g.invocations()).toHaveLength(0);
  } finally {
    await g.dispose();
  }
});

test("the frozen counted payload is sent once with the enforced cap and only the provider key", async () => {
  const g = await gatewayFixture();
  try {
    const reply = await g.call(textRequest({ max_output_tokens: 1000 }), {
      headers: {
        authorization: `Bearer ${WORKSPACE_BEARER}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.0.0.1",
      },
    });
    const text = await reply.text();
    expect(reply.status).toBe(200);
    expect(JSON.parse(text).usage).toEqual({ input_tokens: 40, output_tokens: 10 });
    const [count, generation] = g.provider.journal;
    expect(count?.path).toBe("/v1/responses/input_tokens");
    expect(count?.body).toEqual({
      model: "provider-model-1",
      input: textRequest().input,
      instructions: "Answer briefly.",
      tools: textRequest().tools,
    });
    expect(generation?.body).toMatchObject({ model: "provider-model-1", store: false, max_output_tokens: 40 });
    for (const entry of g.provider.journal) {
      expect(entry.authorization).toBe(`Bearer ${PROVIDER_KEY}`);
      expect(JSON.stringify(entry)).not.toContain(WORKSPACE_BEARER);
      expect(entry.headers["x-forwarded-for"]).toBeUndefined();
    }
    expect(text).not.toContain(PROVIDER_KEY);
    expect(JSON.stringify([...reply.headers])).not.toContain(PROVIDER_KEY);
    g.provider.setMode("fail");
    const failed = await g.call(textRequest());
    const failure = await failed.text();
    expect(failed.status).toBe(502);
    expect(failure).not.toContain(PROVIDER_KEY);
    expect(failure).not.toContain("upstream failure");
    expect(g.provider.generations()).toHaveLength(2);
    expect(g.errors).toHaveLength(0);
  } finally {
    await g.dispose();
  }
});
