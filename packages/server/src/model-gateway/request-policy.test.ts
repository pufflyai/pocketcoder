import { expect, test } from "bun:test";
import { parseModelGatewayConfig } from "./config";
import { ResponseStreamObserver, responseUsage } from "./provider";
import { gatewayRequest } from "./request-policy";

const settings = {
  provider: "openai",
  upstreamUrl: "https://api.openai.com/",
  providerAccountId: "acct",
  models: { "team/fast": { providerModel: "gpt-x", minOutputTokens: 16 } },
  maxRequestBytes: 1024,
  maxConcurrentCalls: 2,
  drainTimeoutMs: 1000,
};

test("gateway configuration is explicit and keeps the provider key out of the JSON settings", () => {
  expect(parseModelGatewayConfig({})).toBeNull();
  expect(() => parseModelGatewayConfig({ POCKETCODER_MODEL_GATEWAY: JSON.stringify(settings) })).toThrow(
    "POCKETCODER_MODEL_GATEWAY_API_KEY",
  );
  const config = parseModelGatewayConfig({
    POCKETCODER_MODEL_GATEWAY: JSON.stringify(settings),
    POCKETCODER_MODEL_GATEWAY_API_KEY: "sk-test",
  });
  expect(config).toMatchObject({ upstreamUrl: "https://api.openai.com", apiKey: "sk-test" });
  for (const bad of [
    { ...settings, upstreamUrl: "http://api.openai.com" },
    { ...settings, apiKey: "sk-inline" },
    { ...settings, models: {} },
    { ...settings, maxRequestBytes: undefined },
  ])
    expect(() =>
      parseModelGatewayConfig({
        POCKETCODER_MODEL_GATEWAY: JSON.stringify(bad),
        POCKETCODER_MODEL_GATEWAY_API_KEY: "k",
      }),
    ).toThrow();
  expect(
    parseModelGatewayConfig({
      POCKETCODER_MODEL_GATEWAY: JSON.stringify({ ...settings, upstreamUrl: "http://127.0.0.1:9999" }),
      POCKETCODER_MODEL_GATEWAY_API_KEY: "k",
    })?.upstreamUrl,
  ).toBe("http://127.0.0.1:9999");
});

test("a supported request is frozen with the provider model, no storage and the counted fields", () => {
  const config = parseModelGatewayConfig({
    POCKETCODER_MODEL_GATEWAY: JSON.stringify(settings),
    POCKETCODER_MODEL_GATEWAY_API_KEY: "k",
  });
  if (!config) throw new Error("Missing config");
  const request = gatewayRequest(
    {
      model: "team/fast",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "found" },
      ],
      tool_choice: "auto",
      max_output_tokens: 64,
      temperature: 0.2,
    },
    ["team/fast"],
    config,
  );
  expect(request).toMatchObject({ logicalModel: "team/fast", requestedOutputTokens: 64, stream: false });
  expect(request.frozen).toMatchObject({ model: "gpt-x", store: false, temperature: 0.2 });
  expect(request.frozen.max_output_tokens).toBeUndefined();
  expect(Object.keys(request.count).sort()).toEqual(["input", "model", "tool_choice"]);
  expect(() => gatewayRequest({ model: "team/fast", input: "hi" }, [], config)).toThrow("not allowed");
  expect(() => gatewayRequest({ model: "team/fast", input: [] }, ["team/fast"], config)).toThrow("explicit input");
  expect(() =>
    gatewayRequest({ model: "team/fast", input: [{ type: "file_search_call" }] }, ["team/fast"], config),
  ).toThrow("Only message");
});

test("usage is trusted only from a complete terminal response of the same identity", () => {
  expect(responseUsage({ id: "r1", usage: { input_tokens: 3, output_tokens: 4 } })?.inputTokens).toBe(3);
  expect(responseUsage({ id: "r1" })).toBeNull();
  expect(responseUsage({ id: "r1", usage: { input_tokens: -1, output_tokens: 4 } })).toBeNull();
  const seen: string[] = [];
  const observer = new ResponseStreamObserver((id) => seen.push(id));
  const encode = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\r\n\r\n`);
  observer.push(encode({ type: "response.created", response: { id: "r1" } }));
  expect(seen).toEqual(["r1"]);
  const completed = encode({
    type: "response.completed",
    response: { id: "r2", usage: { input_tokens: 1, output_tokens: 1 } },
  });
  observer.push(completed.slice(0, 10));
  observer.push(completed.slice(10));
  expect(observer.ended).toBe(true);
  expect(observer.usage).toBeNull();
});
