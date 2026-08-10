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
});
