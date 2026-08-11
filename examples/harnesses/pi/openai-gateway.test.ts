import { describe, expect, test } from "bun:test";
import { createOpenAIGatewayHandler } from "./openai-gateway";

describe("OpenAI gateway", () => {
  test("keeps the provider key on the host and forwards Responses API calls", async () => {
    let upstreamRequest: Request | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      upstreamRequest =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      return Response.json({ id: "resp_example", output: [] });
    }) as typeof fetch;
    const handler = createOpenAIGatewayHandler(
      {
        apiKey: "sk-provider",
        clientBearer: "workspace-bearer",
        project: "proj_example",
      },
      fetchImpl,
    );

    const response = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer workspace-bearer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "test-model", input: "hello" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(upstreamRequest?.url).toBe("https://api.openai.com/v1/responses");
    expect(upstreamRequest?.headers.get("authorization")).toBe("Bearer sk-provider");
    expect(upstreamRequest?.headers.get("openai-project")).toBe("proj_example");
  });

  test("rejects a workspace with the wrong bearer", async () => {
    const handler = createOpenAIGatewayHandler({
      apiKey: "sk-provider",
      clientBearer: "workspace-bearer",
    });
    const response = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
  });

  test("enforces the session model and text-only policy", async () => {
    const handler = createOpenAIGatewayHandler({
      apiKey: "sk-provider",
      clientBearer: "workspace-bearer",
      allowedModel: "approved-model",
    });

    const wrongModel = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer workspace-bearer" },
        body: JSON.stringify({ model: "other-model", input: "hello" }),
      }),
    );
    const imageInput = await handler(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer workspace-bearer" },
        body: JSON.stringify({
          model: "approved-model",
          input: [{ role: "user", content: [{ type: "input_image", image_url: "data:x" }] }],
        }),
      }),
    );

    expect(wrongModel.status).toBe(403);
    expect(imageInput.status).toBe(403);
  });

  test("caps output and bounds the session request count", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "resp_example", output: [] });
    }) as typeof fetch;
    const handler = createOpenAIGatewayHandler(
      {
        apiKey: "sk-provider",
        clientBearer: "workspace-bearer",
        allowedModel: "approved-model",
        maxOutputTokens: 1024,
        maxRequests: 1,
      },
      fetchImpl,
    );
    const request = () =>
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer workspace-bearer" },
        body: JSON.stringify({ model: "approved-model", input: "hello", max_output_tokens: 4096 }),
      });

    expect((await handler(request())).status).toBe(200);
    expect(bodies).toEqual([{ model: "approved-model", input: "hello", max_output_tokens: 1024 }]);
    expect((await handler(request())).status).toBe(429);
  });

  test("rejects expired sessions and oversized request bodies", async () => {
    const expiredHandler = createOpenAIGatewayHandler({
      apiKey: "sk-provider",
      clientBearer: "workspace-bearer",
      expiresAt: new Date("2026-08-11T15:00:00Z"),
      now: () => new Date("2026-08-11T15:00:01Z"),
    });
    const oversizedHandler = createOpenAIGatewayHandler({
      apiKey: "sk-provider",
      clientBearer: "workspace-bearer",
      maxRequestBytes: 1,
    });
    const request = () =>
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer workspace-bearer" },
        body: "{}",
      });

    expect((await expiredHandler(request())).status).toBe(410);
    expect((await oversizedHandler(request())).status).toBe(413);
  });

  test("bounds total accepted request bytes for the session", async () => {
    const handler = createOpenAIGatewayHandler(
      {
        apiKey: "sk-provider",
        clientBearer: "workspace-bearer",
        maxTotalRequestBytes: 2,
      },
      (async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ output: [] })) as typeof fetch,
    );
    const request = () =>
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer workspace-bearer" },
        body: "{}",
      });

    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(429);
  });
});
